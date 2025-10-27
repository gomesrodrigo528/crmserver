#!/usr/bin/env node
/**
 * Servidor Node.js Multi-Tenant com Baileys para integração WhatsApp
 * Gerencia múltiplas conexões WhatsApp simultaneamente
 */

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import express from "express";
import axios from "axios";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ========== CORS CONFIGURATION ========== //
app.use((req, res, next) => {
    // Permitir todas as origens para desenvolvimento
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    // Responder preflight requests
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Configurações
const FLASK_URL = "https://suaagenda.fun";
const PORT = 3000;
const AUTH_DIR = path.join(__dirname, 'auth');

// Classe para gerenciar cada tenant WhatsApp
class WhatsAppTenant {
    constructor(tenantId) {
        this.tenantId = tenantId;
        this.sock = null;
        this.isConnected = false;
        this.qrCode = null;
        this.authDir = path.join(AUTH_DIR, tenantId);
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.isConnecting = false;
        this.reconnectTimeout = null;
        this.sessionCleanupInProgress = false;
    }

    async initialize() {
        if (this.isConnecting) {
            console.log(`⏳ Já existe uma inicialização em andamento para o tenant ${this.tenantId}`);
            return;
        }

        this.isConnecting = true;
        
        try {
            // Cria diretório de autenticação se não existir
            await fs.mkdir(this.authDir, { recursive: true });

            // Usa estado de autenticação persistente para este tenant
            const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

            // Busca a versão mais recente do Baileys
            const { version } = await fetchLatestBaileysVersion();

            // Cria o socket do WhatsApp para este tenant
            this.sock = makeWASocket({
                version,
                printQRInTerminal: false,
                auth: state,
                browser: [`WhatsApp-${this.tenantId}`, 'Chrome', '1.0.0'],
                generateHighQualityLinkPreview: false,
                syncFullHistory: false,
                markOnlineOnConnect: false,
                defaultQueryTimeoutMs: 30000,
                keepAliveIntervalMs: 20000,
                connectTimeoutMs: 60000
            });

            // Salva credenciais quando atualizadas
            this.sock.ev.on('creds.update', saveCreds);

            // Evento de conexão
            this.sock.ev.on('connection.update', (update) => {
                this.handleConnectionUpdate(update);
            });

            // Evento de mensagens recebidas
            this.sock.ev.on('messages.upsert', async (m) => {
                await this.handleMessage(m);
            });

            console.log(`✅ Tenant ${this.tenantId} inicializado`);

        } catch (error) {
            console.error(`❌ Erro ao inicializar tenant ${this.tenantId}:`, error);
            throw error;
        } finally {
            this.isConnecting = false;
        }
    }

    async handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            this.qrCode = qr;
            this.reconnectAttempts = 0; // Reset das tentativas quando QR é gerado
            console.log(`📱 QR Code gerado para tenant ${this.tenantId}`);
            this.emit('qr', { tenantId: this.tenantId, qr: qr });
            return;
        }

        if (connection === 'close') {
            this.isConnected = false;
            this.qrCode = null;

            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode;
            const isLogout = statusCode === DisconnectReason.loggedOut || statusCode === 401;
            const shouldReconnect = !isLogout;

            console.log(`❌ Tenant ${this.tenantId} desconectado:`, {
                error: error?.message || 'Erro desconhecido',
                code: statusCode,
                shouldReconnect: shouldReconnect
            });

            // Limpa o socket atual
            this.sock = null;

            // Se foi logout, limpa a sessão
            if (isLogout) {
                console.log(`🚪 Tenant ${this.tenantId} deslogado pelo usuário`);
                await this.cleanupSession();
                return;
            }

            // Se não deve reconectar, para aqui
            if (!shouldReconnect) {
                return;
            }

            // Agenda reconexão
            this.scheduleReconnect('Conexão encerrada inesperadamente');

        } else if (connection === 'open') {
            console.log(`✅ Tenant ${this.tenantId} conectado ao WhatsApp!`);
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.qrCode = null;
            this.emit('connected', { tenantId: this.tenantId });
        }
    }

    async handleMessage(m) {
        try {
            const message = m.messages[0];

            // Verificações de segurança
            if (!message) {
                console.log(`⚠️ Mensagem vazia recebida no tenant ${this.tenantId}`);
                return;
            }

            // Verifica se é uma mensagem de texto
            if (!message.message?.conversation && !message.message?.extendedTextMessage?.text) {
                return; // Não é texto, ignora
            }

            // Extrai o texto da mensagem
            const text = message.message.conversation || message.message.extendedTextMessage.text;

            // Extrai o número do telefone
            const phone = message.key.remoteJid.replace("@s.whatsapp.net", "");

            // Ignora mensagens próprias
            if (message.key.fromMe) {
                return;
            }

            // Verifica se o telefone é válido
            if (!phone || phone.length < 10) {
                console.log(`⚠️ Telefone inválido: ${phone}`);
                return;
            }

            console.log(`📨 [${this.tenantId}] Mensagem recebida de ${phone}: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);

            // Envia diretamente para o Flask via webhook
            try {
                const response = await axios.post(`${FLASK_URL}/webhook/whatsapp`, {
                    phone: phone,
                    message: text,
                    message_type: 'texto',
                    empresa_id: this.tenantId
                }, {
                    timeout: 10000 // 10 segundos timeout
                });

                if (response.status === 200) {
                    console.log(`✅ [${this.tenantId}] Webhook enviado para Flask: ${phone}`);
                } else {
                    console.error(`❌ [${this.tenantId}] Flask retornou status ${response.status}`);
                }
            } catch (error) {
                if (error.code === 'ECONNREFUSED') {
                    console.error(`❌ [${this.tenantId}] Flask não está rodando em ${FLASK_URL}`);
                } else {
                    console.error(`❌ [${this.tenantId}] Erro ao enviar webhook para Flask: ${error.message}`);
                }
            }

        } catch (error) {
            console.error(`❌ [${this.tenantId}] Erro ao processar mensagem:`, error.message);
        }
    }

    async connect() {
        // Limpa qualquer tentativa de reconexão agendada
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        // Se já está conectado, não faz nada
        if (this.isConnected && this.sock) {
            console.log(`✅ Tenant ${this.tenantId} já está conectado`);
            return;
        }

        // Se está no meio de uma conexão, aguarda um pouco e tenta novamente
        if (this.isConnecting) {
            console.log(`⏳ Conexão já em andamento para o tenant ${this.tenantId}, aguardando...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            if (this.isConnecting) {
                throw new Error('Timeout ao aguardar conexão existente');
            }
            return this.connect(); // Tenta novamente
        }

        try {
            console.log(`🔌 Iniciando conexão para tenant ${this.tenantId}`);
            await this.initialize();
        } catch (error) {
            console.error(`❌ Erro ao conectar tenant ${this.tenantId}:`, error);
            throw error;
        }
    }

    async reconnect() {
        console.log(`🔄 Reconectando tenant ${this.tenantId}...`);
        try {
            await this.disconnect();
            // Pequena pausa antes de reconectar
            await new Promise(resolve => setTimeout(resolve, 3000));
            await this.connect();
        } catch (error) {
            console.error(`❌ Erro na reconexão do tenant ${this.tenantId}:`, error);
            throw error;
        }
    }

    async disconnect() {
        // Limpa qualquer tentativa de reconexão agendada
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        if (!this.sock) {
            return;
        }

        try {
            // Verifica se o socket ainda está aberto antes de tentar logout
            if (this.sock.ws && this.sock.ws.readyState === 1) {
                await this.sock.logout();
                console.log(`✅ Tenant ${this.tenantId} desconectado com sucesso`);
            }
        } catch (error) {
            console.error(`❌ Erro ao desconectar tenant ${this.tenantId}:`, error.message);
        } finally {
            this.sock = null;
            this.isConnected = false;
            this.qrCode = null;
        }
    }

    async sendMessage(phone, message) {
        if (!this.isConnected || !this.sock) {
            throw new Error('Tenant não está conectado');
        }

        // Formata o número do telefone
        const formattedPhone = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

        // Envia a mensagem
        await this.sock.sendMessage(formattedPhone, { text: message });

        console.log(`✅ [${this.tenantId}] Mensagem enviada para ${phone}: ${message}`);
        return { success: true, message: 'Mensagem enviada com sucesso' };
    }

    async cleanupSession() {
        if (this.sessionCleanupInProgress) return;
        this.sessionCleanupInProgress = true;

        try {
            console.log(`🧹 Limpando sessão do tenant ${this.tenantId}...`);
            if (fs.existsSync(this.authDir)) {
                await fs.rm(this.authDir, { recursive: true, force: true });
                console.log(`✅ Sessão do tenant ${this.tenantId} limpa com sucesso`);
            }
        } catch (error) {
            console.error(`❌ Erro ao limpar sessão do tenant ${this.tenantId}:`, error);
        } finally {
            this.sessionCleanupInProgress = false;
        }
    }

    scheduleReconnect(reason) {
        // Limpa qualquer reconexão pendente
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }

        // Verifica se atingiu o limite de tentativas
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log(`❌ Limite de tentativas de reconexão atingido para o tenant ${this.tenantId}`);
            this.emit('reconnect_failed', { 
                tenantId: this.tenantId, 
                reason: 'Limite de tentativas atingido',
                attempts: this.reconnectAttempts
            });
            return;
        }

        // Incrementa o contador de tentativas
        this.reconnectAttempts++;

        // Cálculo de backoff exponencial (mínimo 5s, máximo 60s)
        const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);

        console.log(`⏳ Tentando reconectar tenant ${this.tenantId} em ${delay/1000}s (tentativa ${this.reconnectAttempts}/${this.maxReconnectAttempts}). Motivo: ${reason}`);

        this.reconnectTimeout = setTimeout(async () => {
            try {
                await this.reconnect();
            } catch (error) {
                console.error(`❌ Falha na reconexão do tenant ${this.tenantId}:`, error.message);
                // Agenda uma nova tentativa
                this.scheduleReconnect('Falha na reconexão');
            }
        }, delay);
    }

    getStatus() {
        return {
            tenantId: this.tenantId,
            connected: this.isConnected,
            qrCode: this.qrCode ? true : false,
            reconnectAttempts: this.reconnectAttempts,
            isConnecting: this.isConnecting,
            maxReconnectAttempts: this.maxReconnectAttempts
        };
    }
}

// Gerenciador de tenants
class TenantManager {
    constructor() {
        this.tenants = new Map();
        this.events = new Map();
    }

    async createTenant(tenantId) {
        if (this.tenants.has(tenantId)) {
            throw new Error(`Tenant ${tenantId} já existe`);
        }

        const tenant = new WhatsAppTenant(tenantId);
        this.tenants.set(tenantId, tenant);

        // Configura listeners de eventos
        tenant.on = (event, callback) => {
            if (!this.events.has(event)) {
                this.events.set(event, new Map());
            }
            this.events.get(event).set(tenantId, callback);
        };

        tenant.emit = (event, data) => {
            if (this.events.has(event)) {
                const callbacks = this.events.get(event);
                if (callbacks.has(tenantId)) {
                    callbacks.get(tenantId)(data);
                }
            }
        };

        await tenant.initialize();
        return tenant;
    }

    async getTenant(tenantId) {
        if (!this.tenants.has(tenantId)) {
            await this.createTenant(tenantId);
        }
        return this.tenants.get(tenantId);
    }

    async deleteTenant(tenantId) {
        const tenant = this.tenants.get(tenantId);
        if (tenant) {
            await tenant.disconnect();
            this.tenants.delete(tenantId);
            // Remove eventos
            this.events.forEach(eventMap => eventMap.delete(tenantId));
            // Remove diretório de auth
            try {
                await fs.rmdir(tenant.authDir, { recursive: true });
            } catch (error) {
                console.error(`Erro ao remover diretório de auth para ${tenantId}:`, error);
            }
        }
    }

    getAllTenants() {
        const result = [];
        for (const [tenantId, tenant] of this.tenants) {
            result.push(tenant.getStatus());
        }
        return result;
    }
}

// Instância global do gerenciador de tenants
const tenantManager = new TenantManager();

// ========== APIs ========== //

// ========== APIs ========== //

/**
 * API: Enviar mensagem via empresa (compatibilidade com Flask)
 */
app.post('/send/:empresaId', async (req, res) => {
    try {
        const { empresaId } = req.params;
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({
                error: 'Telefone e mensagem são obrigatórios'
            });
        }

        // Usar empresaId como tenantId
        const tenantId = empresaId.toString();
        const tenant = await tenantManager.getTenant(tenantId);
        const result = await tenant.sendMessage(phone, message);

        res.json({
            success: true,
            empresaId: empresaId,
            ...result
        });

    } catch (error) {
        console.error(`❌ Erro ao enviar mensagem via empresa ${req.params.empresaId}:`, error);
        res.status(500).json({
            error: 'Erro ao enviar mensagem',
            details: error.message
        });
    }
});

/**
 * API: Webhook para enviar mensagens para o Flask
 */
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;

        if (!data || !data.phone || !data.message) {
            return res.status(400).json({
                error: 'Dados inválidos'
            });
        }

        const phone = data.phone;
        const message = data.message;
        const messageType = data.message_type || 'texto';
        const mediaUrl = data.media_url;
        const mediaFilename = data.media_filename;
        const profileName = data.profile_name;
        const profilePicture = data.profile_picture;
        const empresaId = data.empresa_id || data.tenantId || 1;

        console.log(`📨 Webhook recebido de ${phone} para empresa ${empresaId}`);

        // Envia para o Flask via webhook
        try {
            await axios.post(`${FLASK_URL}/webhook/whatsapp`, {
                phone: phone,
                message: message,
                message_type: messageType,
                media_url: mediaUrl,
                media_filename: mediaFilename,
                profile_name: profileName,
                profile_picture: profilePicture,
                empresa_id: empresaId
            });
            console.log(`✅ Webhook enviado para Flask: ${phone}`);
        } catch (error) {
            console.error(`❌ Erro ao enviar webhook para Flask: ${error.message}`);
        }

        res.json({
            success: true,
            message: 'Webhook processado com sucesso'

        });

    } catch (error) {
        console.error('❌ Erro no webhook:', error);
        res.status(500).json({
            error: 'Erro interno do servidor'
        });
    }
});

/**
 * API: Listar todos os tenants
 */
app.get('/tenants', (req, res) => {
    try {
        const tenants = tenantManager.getAllTenants();
        res.json({
            success: true,
            tenants: tenants
        });
    } catch (error) {
        console.error('❌ Erro ao listar tenants:', error);
        res.status(500).json({
            error: 'Erro ao listar tenants',
            details: error.message
        });
    }
});

/**
 * API: Criar um novo tenant
 */
app.post('/tenants', async (req, res) => {
    try {
        const { tenantId } = req.body;

        if (!tenantId) {
            return res.status(400).json({
                error: 'tenantId é obrigatório'
            });
        }

        const tenant = await tenantManager.createTenant(tenantId);
        res.json({
            success: true,
            message: `Tenant ${tenantId} criado com sucesso`,
            tenant: tenant.getStatus()
        });
    } catch (error) {
        console.error('❌ Erro ao criar tenant:', error);
        res.status(500).json({
            error: 'Erro ao criar tenant',
            details: error.message
        });
    }
});

/**
 * API: Obter QR code para um tenant
 */
app.get('/tenants/:tenantId/qr', async (req, res) => {
    try {
        const { tenantId } = req.params;
        const tenant = await tenantManager.getTenant(tenantId);

        if (tenant.isConnected) {
            return res.json({
                success: true,
                connected: true,
                message: 'Tenant já está conectado'
            });
        }

        if (tenant.qrCode) {
            // Mostra QR no terminal também
            console.log(`📱 QR Code para tenant ${tenantId}:`);
            qrcode.generate(tenant.qrCode, { small: true });

            return res.json({
                success: true,
                qrCode: tenant.qrCode,
                message: 'Escaneie o QR code com seu WhatsApp'
            });
        }

        // Se não tem QR, força reconexão para gerar um novo
        await tenant.connect();

        // Aguarda um pouco para gerar o QR
        let attempts = 0;
        while (!tenant.qrCode && attempts < 10) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }

        if (tenant.qrCode) {
            console.log(`📱 QR Code para tenant ${tenantId}:`);
            qrcode.generate(tenant.qrCode, { small: true });

            res.json({
                success: true,
                qrCode: tenant.qrCode,
                message: 'Escaneie o QR code com seu WhatsApp'
            });
        } else {
            res.status(503).json({
                success: false,
                error: 'Não foi possível gerar QR code. Tente novamente.'
            });
        }
    } catch (error) {
        console.error(`❌ Erro ao obter QR para tenant ${req.params.tenantId}:`, error);
        res.status(500).json({
            error: 'Erro ao obter QR code',
            details: error.message
        });
    }
});

/**
 * API: Status de um tenant específico
 */
app.get('/tenants/:tenantId/status', async (req, res) => {
    try {
        const { tenantId } = req.params;
        const tenant = await tenantManager.getTenant(tenantId);

        res.json({
            success: true,
            tenant: tenant.getStatus()
        });
    } catch (error) {
        console.error(`❌ Erro ao obter status do tenant ${req.params.tenantId}:`, error);
        res.status(500).json({
            error: 'Erro ao obter status do tenant',
            details: error.message
        });
    }
});

/**
 * API: Desconectar um tenant
 */
app.delete('/tenants/:tenantId', async (req, res) => {
    try {
        const { tenantId } = req.params;
        await tenantManager.deleteTenant(tenantId);

        res.json({
            success: true,
            message: `Tenant ${tenantId} desconectado e removido com sucesso`
        });
    } catch (error) {
        console.error(`❌ Erro ao desconectar tenant ${req.params.tenantId}:`, error);
        res.status(500).json({
            error: 'Erro ao desconectar tenant',
            details: error.message
        });
    }
});

/**
 * API: Enviar mensagem via tenant específico
 */
app.post('/tenants/:tenantId/send', async (req, res) => {
    try {
        const { tenantId } = req.params;
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({
                error: 'Telefone e mensagem são obrigatórios'
            });
        }

        const tenant = await tenantManager.getTenant(tenantId);
        const result = await tenant.sendMessage(phone, message);

        res.json({
            success: true,
            tenantId: tenantId,
            ...result
        });

    } catch (error) {
        console.error(`❌ Erro ao enviar mensagem via tenant ${req.params.tenantId}:`, error);
        res.status(500).json({
            error: 'Erro ao enviar mensagem',
            details: error.message
        });
    }
});

/**
 * API: Status geral (compatibilidade com Flask)
 */
app.get('/status', (req, res) => {
    try {
        const connections = {};
        for (const [tenantId, tenant] of tenantManager.tenants) {
            connections[tenantId] = tenant.getStatus();
        }

        res.json({
            success: true,
            connections: connections,
            tenantsCount: tenantManager.tenants.size,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Erro ao obter status geral:', error);
        res.status(500).json({
            error: 'Erro ao obter status geral',
            details: error.message
        });
    }
});

/**
 * API: Conectar tenant (compatibilidade com Flask)
 */
app.post('/connect/:empresaId', async (req, res) => {
    try {
        const { empresaId } = req.params;
        const tenantId = empresaId.toString();

        console.log(`📞 Iniciando conexão para empresa ${empresaId}`);

        // Cria o tenant se não existir
        const tenant = await tenantManager.getTenant(tenantId);

        // Se já está conectado, retorna sucesso
        if (tenant.isConnected) {
            return res.json({
                success: true,
                connected: true,
                message: 'Empresa já está conectada'
            });
        }

        // Inicia a conexão
        await tenant.connect();

        res.json({
            success: true,
            message: 'Conexão iniciada. Aguarde o QR code.'
        });

    } catch (error) {
        console.error(`❌ Erro ao conectar empresa ${req.params.empresaId}:`, error);
        res.status(500).json({
            error: 'Erro ao conectar empresa',
            details: error.message
        });
    }
});

/**
 * API: Obter QR code (compatibilidade com Flask)
 */
app.get('/qr/:empresaId', async (req, res) => {
    try {
        const { empresaId } = req.params;
        const tenantId = empresaId.toString();

        const tenant = await tenantManager.getTenant(tenantId);

        // Se já está conectado, retorna sucesso
        if (tenant.isConnected) {
            return res.json({
                success: true,
                connected: true,
                message: 'Empresa já está conectada'
            });
        }

        // Se tem QR code disponível, retorna
        if (tenant.qrCode) {
            console.log(`📱 QR Code para empresa ${empresaId}:`);
            qrcode.generate(tenant.qrCode, { small: true });

            return res.json({
                success: true,
                qr: tenant.qrCode,
                message: 'Escaneie o QR code com seu WhatsApp'
            });
        }

        // Se não tem QR, força reconexão para gerar um novo
        await tenant.connect();

        // Aguarda um pouco para gerar o QR (máximo 15 segundos)
        let attempts = 0;
        const maxAttempts = 15;

        while (!tenant.qrCode && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;

            if (attempts % 5 === 0) {
                console.log(`⏳ Aguardando QR code para empresa ${empresaId} (${attempts}s/${maxAttempts}s)`);
            }
        }

        if (tenant.qrCode) {
            console.log(`📱 QR Code para empresa ${empresaId}:`);
            qrcode.generate(tenant.qrCode, { small: true });

            res.json({
                success: true,
                qr: tenant.qrCode,
                message: 'Escaneie o QR code com seu WhatsApp'
            });
        } else {
            console.error(`❌ Timeout ao gerar QR code para empresa ${empresaId}`);
            res.status(408).json({
                success: false,
                error: 'Timeout ao gerar QR code. Tente novamente.',
                timeout: true
            });
        }

    } catch (error) {
        console.error(`❌ Erro ao obter QR para empresa ${req.params.empresaId}:`, error);
        res.status(500).json({
            error: 'Erro ao obter QR code',
            details: error.message
        });
    }
});

/**
 * API: Desconectar empresa (compatibilidade com Flask)
 */
app.post('/disconnect/:empresaId', async (req, res) => {
    try {
        const { empresaId } = req.params;
        const tenantId = empresaId.toString();

        await tenantManager.deleteTenant(tenantId);

        res.json({
            success: true,
            message: `Empresa ${empresaId} desconectada com sucesso`
        });

    } catch (error) {
        console.error(`❌ Erro ao desconectar empresa ${req.params.empresaId}:`, error);
        res.status(500).json({
            error: 'Erro ao desconectar empresa',
            details: error.message
        });
    }
});

/**
 * API: Limpar todas as conexões (debug)
 */
app.post('/clear-all', async (req, res) => {
    try {
        console.log('🔄 Desconectando todas as empresas...');

        for (const [tenantId, tenant] of tenantManager.tenants) {
            await tenant.disconnect();
        }

        tenantManager.tenants.clear();
        tenantManager.events.clear();

        res.json({
            success: true,
            message: 'Todas as conexões foram desconectadas com sucesso',
            connectionsCleared: tenantManager.tenants.size
        });

    } catch (error) {
        console.error('❌ Erro ao limpar conexões:', error);
        res.status(500).json({
            error: 'Erro ao limpar conexões',
            details: error.message
        });
    }
});

/**
 * API: Reinicializar empresa específica (debug)
 */
app.post('/restart/:empresaId', async (req, res) => {
    try {
        const { empresaId } = req.params;
        const tenantId = empresaId.toString();

        console.log(`🔄 Reinicializando empresa ${empresaId}...`);

        // Desconecta se existir
        await tenantManager.deleteTenant(tenantId);

        // Cria novamente
        const tenant = await tenantManager.getTenant(tenantId);

        res.json({
            success: true,
            message: `Empresa ${empresaId} reinicializada com sucesso`,
            tenant: tenant.getStatus()
        });

    } catch (error) {
        console.error(`❌ Erro ao reinicializar empresa ${req.params.empresaId}:`, error);
        res.status(500).json({
            error: 'Erro ao reinicializar empresa',
            details: error.message
        });
    }
});

/**
 * API: Health check
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'baileys-whatsapp-multitenant',
        tenantsCount: tenantManager.tenants.size,
        timestamp: new Date().toISOString()
    });
});

/**
 * Inicia o servidor
 */
app.listen(PORT, async () => {
    console.log(`🚀 Servidor Baileys Multi-Tenant rodando na porta ${PORT}`);
    console.log(`🔗 APIs Flask (compatibilidade):`);
    console.log(`   POST /send/:empresaId - Enviar mensagem via empresa (Flask)`);
    console.log(`   POST /webhook - Webhook para Flask`);
    console.log(`   GET /status - Status geral (Flask)`);
    console.log(`   POST /connect/:empresaId - Conectar empresa (Flask)`);
    console.log(`   GET /qr/:empresaId - Obter QR code (Flask)`);
    console.log(`   POST /disconnect/:empresaId - Desconectar empresa (Flask)`);
    console.log(`🔗 APIs Multi-Tenant:`);
    console.log(`   GET /tenants - Listar todos os tenants`);
    console.log(`   POST /tenants - Criar novo tenant`);
    console.log(`   GET /tenants/:tenantId/qr - Obter QR code do tenant`);
    console.log(`   GET /tenants/:tenantId/status - Status do tenant`);
    console.log(`   DELETE /tenants/:tenantId - Desconectar tenant`);
    console.log(`   POST /tenants/:tenantId/send - Enviar mensagem via tenant`);
    console.log(`🔗 APIs Debug:`);
    console.log(`   POST /clear-all - Limpar todas as conexões`);
    console.log(`   POST /restart/:empresaId - Reinicializar empresa específica`);
    console.log(`🔗 APIs Gerais:`);
    console.log(`   GET /health - Health check`);
    console.log(`📱 Sistema Multi-Tenant inicializado!`);
    console.log(`🔄 Flask URL: ${FLASK_URL}`);

    // Cria diretório de auth se não existir
    
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});


