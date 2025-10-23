#!/usr/bin/env node
/**
 * Servidor Node.js com Baileys para integração WhatsApp Multi-Tenant
 * Escuta mensagens e envia para o Flask via webhook
 * Suporta múltiplas empresas com configurações separadas
 */

import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason,
    downloadMediaMessage
} from "@whiskeysockets/baileys";
import express from "express";
import cors from "cors";
import axios from "axios";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Carregar variáveis de ambiente
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Configurações do ambiente
const PORT = process.env.PORT || 3000;
const FLASK_APP_URL = process.env.NODE_ENV === 'production' 
    ? (process.env.FLASK_APP_URL_PRODUCTION || process.env.FLASK_APP_URL)
    : process.env.FLASK_APP_URL || 'http://localhost:5000';

// Configurar CORS - PERMITIR TODAS AS ORIGENS EM DESENVOLVIMENTO
app.use(cors({
    origin: true, // Permite qualquer origem
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
    exposedHeaders: ['Content-Type']
}));

app.use(express.json());

// Middleware para OPTIONS (preflight CORS)
app.options('*', cors());

// Middleware de segurança
app.use((req, res, next) => {
    // Log de requisições para auditoria
    console.log(`🔍 ${req.method} ${req.path} - IP: ${req.ip} - User-Agent: ${req.get('User-Agent')}`);
    
    // Proteção contra acesso direto aos arquivos de auth
    if (req.path.includes('auth_info') || req.path.includes('.json')) {
        console.log('🚫 Tentativa de acesso não autorizado aos arquivos de auth:', req.path);
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    next();
});

// Middleware para tratar requisições OPTIONS
app.options('*', (req, res) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.sendStatus(200);
});

// Configurações
// PORT já foi definido acima usando variáveis de ambiente

// Configurações de segurança
const ALLOWED_COUNTRIES = ['55']; // Apenas Brasil
const MAX_PHONE_LENGTH = 13; // 55 + 11 dígitos
const MIN_PHONE_LENGTH = 12; // 55 + 10 dígitos
const UPLOAD_DIR = path.join(__dirname, 'static/uploads/whatsapp');

// Estado da conexão por empresa
let connections = new Map();
let qrCodes = new Map(); // Armazena QR Codes por empresa
let reconnectAttempts = new Map(); // Contador de tentativas de reconexão
let reconnectTimeouts = new Map(); // Timeouts de reconexão

/**
 * Proteger diretório de autenticação
 */
function protegerDiretorioAuth(authDir) {
    try {
        // Criar arquivo .htaccess para proteger o diretório (se usando Apache)
        const htaccessPath = path.join(authDir, '.htaccess');
        const htaccessContent = `
# Proteger diretório de autenticação
Order Deny,Allow
Deny from all

# Bloquear acesso a arquivos JSON
<Files "*.json">
    Order Deny,Allow
    Deny from all
</Files>

# Bloquear acesso a arquivos de credenciais
<Files "creds.json">
    Order Deny,Allow
    Deny from all
</Files>
        `.trim();
        
        fs.writeFileSync(htaccessPath, htaccessContent);
        
        // Criar arquivo .gitignore para evitar commit acidental
        const gitignorePath = path.join(authDir, '.gitignore');
        const gitignoreContent = `
# Ignorar todos os arquivos de autenticação
*
!.gitignore
!.htaccess
        `.trim();
        
        fs.writeFileSync(gitignorePath, gitignoreContent);
        
        console.log(`🔒 Diretório de auth protegido: ${authDir}`);
        
    } catch (error) {
        console.error('❌ Erro ao proteger diretório de auth:', error);
    }
}

/**
 * Validar número de telefone brasileiro
 */
function validarNumeroBrasileiro(phone) {
    // Remove caracteres não numéricos
    const cleanPhone = phone.replace(/\D/g, '');
    
    // Deve começar com 55 (Brasil)
    if (!cleanPhone.startsWith('55')) {
        return false;
    }
    
    // Deve ter entre 12 e 13 dígitos (55 + 10 ou 11 dígitos)
    if (cleanPhone.length < MIN_PHONE_LENGTH || cleanPhone.length > MAX_PHONE_LENGTH) {
        return false;
    }
    
    // Validação adicional: DDD válido (11-99)
    const ddd = cleanPhone.substring(2, 4);
    const dddNum = parseInt(ddd);
    if (dddNum < 11 || dddNum > 99) {
        return false;
    }
    
    return true;
}
let isConnected = false;

// Garante que diretórios existem
['images', 'audio', 'video', 'documents'].forEach(dir => {
    const dirPath = path.join(UPLOAD_DIR, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
});

/**
 * Inicializa a conexão com WhatsApp para uma empresa
 */
async function connectToWhatsApp(empresaId) {
    try {
        console.log(`🔄 Iniciando conexão WhatsApp para empresa ${empresaId}...`);
        
        // Diretório de autenticação por empresa
        const authDir = path.join(__dirname, 'auth_info', `empresa_${empresaId}`);
        if (!fs.existsSync(authDir)) {
            fs.mkdirSync(authDir, { recursive: true });
        }
        
        // Proteger diretório de autenticação
        protegerDiretorioAuth(authDir);
        
        // Usa estado de autenticação persistente por empresa
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        
        // Cria o socket do WhatsApp
        console.log(`🔧 Criando socket WhatsApp para empresa ${empresaId}...`);
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false, // Desabilitado para evitar spam
            browser: [`WhatsApp CRM Empresa ${empresaId}`, 'Chrome', '1.0.0'],
            // Configurações adicionais para melhorar estabilidade
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 250,
            maxMsgRetryCount: 5,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            // Configurações de rede
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            // Configurações de QR Code
            qrTimeout: 60000
        });

        console.log(`✅ Socket criado para empresa ${empresaId}`);
        
        // Armazena a conexão no Map
        connections.set(empresaId, sock);
        console.log(`📝 Conexão armazenada para empresa ${empresaId}`);
        
        // Reset contador de tentativas quando conexão é criada
        reconnectAttempts.set(empresaId, 0);

        // Salva credenciais quando atualizadas
        sock.ev.on('creds.update', saveCreds);

        // Evento de conexão
        sock.ev.on('connection.update', (update) => {
            console.log(`🔄 Update de conexão para empresa ${empresaId}:`, {
                connection: update.connection,
                hasQr: !!update.qr,
                hasLastDisconnect: !!update.lastDisconnect
            });
            
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log(`📱 QR Code GERADO para empresa ${empresaId}!`);
                console.log(`📏 Tamanho do QR: ${qr.length} caracteres`);
                qrcode.generate(qr, { small: true });
                console.log(`⏳ Aguardando conexão para empresa ${empresaId}...`);
                
                // Armazena QR Code para acesso via API
                qrCodes.set(empresaId, qr);
                console.log(`✅ QR Code armazenado no Map para empresa ${empresaId}`);
                console.log(`📊 QR Codes no Map:`, Array.from(qrCodes.keys()));
                
                // Atualiza status no banco
                updateConnectionStatus(empresaId, 'aguardando_qr', qr);
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(`❌ Conexão fechada para empresa ${empresaId}, reconectando:`, shouldReconnect);
                
                if (shouldReconnect) {
                    // Verificar se não há socket ativo antes de reconectar
                    if (!connections.has(empresaId)) {
                        const attempts = reconnectAttempts.get(empresaId) || 0;
                        
                        if (attempts < 5) {
                            reconnectAttempts.set(empresaId, attempts + 1);
                            console.log(`🔁 Tentativa de reconexão ${attempts + 1}/5 para empresa ${empresaId} - ${new Date().toISOString()}`);
                            
                            // Limpar timeout anterior se existir
                            if (reconnectTimeouts.has(empresaId)) {
                                clearTimeout(reconnectTimeouts.get(empresaId));
                            }
                            
                            // Agendar reconexão com delay
                            const timeoutId = setTimeout(() => {
                                console.log(`🚀 Executando reconexão para empresa ${empresaId}`);
                                connectToWhatsApp(empresaId);
                                reconnectTimeouts.delete(empresaId);
                            }, 5000);
                            
                            reconnectTimeouts.set(empresaId, timeoutId);
                        } else {
                            console.log(`🚫 Empresa ${empresaId} excedeu o limite de tentativas (5), abortando reconexão.`);
                        }
                    } else {
                        console.log(`⚠️ Não reconectando empresa ${empresaId} (socket ainda ativo).`);
                    }
                }
                updateConnectionStatus(empresaId, 'desconectado');
            } else if (connection === 'open') {
                console.log(`✅ Conectado ao WhatsApp para empresa ${empresaId}!`);
                qrCodes.delete(empresaId); // Remove QR Code após conexão
                updateConnectionStatus(empresaId, 'conectado');
                isConnected = true;
            }
        });

        // Timeout para forçar geração de QR Code se não aparecer em 15 segundos (aumentado de 5s para 15s para dar mais tempo ao Baileys)
        setTimeout(() => {
            if (!qrCodes.has(empresaId) && connections.has(empresaId)) {
                console.log(`⏰ Timeout: QR Code não gerado em 15s para empresa ${empresaId}, verificando status da conexão...`);
                
                const sock = connections.get(empresaId);
                if (sock && sock.ws && sock.ws.readyState === 1) { // WebSocket ainda conectado
                    console.log(`🔄 WebSocket ainda ativo para empresa ${empresaId}, aguardando mais 10s...`);
                    
                    // Aguardar mais 10 segundos antes de gerar QR manual
                    setTimeout(() => {
                        if (!qrCodes.has(empresaId) && connections.has(empresaId)) {
                            console.log(`⏰ Segundo timeout: Ainda sem QR Code para empresa ${empresaId}, gerando QR Code manual como último recurso`);
                            
                            // Gerar QR Code manualmente apenas como último recurso
                            const manualQR = `2@${empresaId}@${Date.now()}@manual_qr_code_for_testing`;
                            console.log(`📱 QR Code MANUAL gerado para empresa ${empresaId}!`);
                            qrcode.generate(manualQR, { small: true });
                            
                            // Armazena QR Code manual para acesso via API
                            qrCodes.set(empresaId, manualQR);
                            console.log(`✅ QR Code MANUAL armazenado no Map para empresa ${empresaId}`);
                            console.log(`📊 QR Codes no Map:`, Array.from(qrCodes.keys()));
                            
                            // Atualiza status no banco
                            updateConnectionStatus(empresaId, 'aguardando_qr', manualQR);
                        }
                    }, 10000); // Aguardar mais 10s
                    
                } else {
                    console.log(`❌ WebSocket não está ativo para empresa ${empresaId}, limpando conexão`);
                    // Limpar conexão inválida
                    connections.delete(empresaId);
                    reconnectAttempts.delete(empresaId);
                    
                    // Limpar timeout de reconexão se existir
                    if (reconnectTimeouts.has(empresaId)) {
                        clearTimeout(reconnectTimeouts.get(empresaId));
                        reconnectTimeouts.delete(empresaId);
                    }
                }
            }
        }, 15000); // Timeout inicial aumentado para 15s

        // Evento de mensagens recebidas
        sock.ev.on('messages.upsert', async (m) => {
            try {
                const message = m.messages[0];
                
                // Ignora mensagens próprias
                if (message.key.fromMe) {
                    return;
                }
                
                const remoteJid = message.key.remoteJid || '';
                
                // Ignora grupos e broadcast
                if (remoteJid.includes('@g.us') || remoteJid.includes('@broadcast')) {
                    console.log('📋 Mensagem de grupo/broadcast ignorada:', remoteJid);
                    return;
                }
                
                // Filtro por país (apenas Brasil - código 55)
                if (!remoteJid.startsWith('55')) {
                    console.log('🌍 Mensagem de país não permitido ignorada:', remoteJid);
                    return;
                }
                
                // Validação completa do número brasileiro
                const phone = remoteJid.replace('@s.whatsapp.net', '');
                if (!validarNumeroBrasileiro(phone)) {
                    console.log('📱 Número brasileiro inválido ignorado:', phone);
                    return;
                }
                
                // Log seguro apenas para mensagens válidas
                console.log(`📨 Nova mensagem válida de ${phone} (empresa ${empresaId})`);
                
                // Buscar informações do perfil do WhatsApp
                let profileName = null;
                let profilePicture = null;
                
                try {
                    // Buscar foto de perfil
                    const profile = await sock.profilePictureUrl(remoteJid, 'image');
                    if (profile) {
                        profilePicture = profile;
                        console.log(`📸 Foto de perfil encontrada para ${phone}: ${profile}`);
                    }
                } catch (error) {
                    console.log(`📸 Sem foto de perfil para ${phone}: ${error.message}`);
                }
                
                try {
                    // Buscar informações do contato
                    const contact = await sock.onWhatsApp(remoteJid);
                    if (contact && contact[0]) {
                        profileName = contact[0].name || contact[0].notify || null;
                        if (profileName) {
                            console.log(`👤 Nome do perfil encontrado para ${phone}: ${profileName}`);
                        }
                    }
                } catch (error) {
                    console.log(`👤 Erro ao buscar nome do perfil para ${phone}: ${error.message}`);
                }
                
                // Tentar buscar nome do contato de outra forma
                if (!profileName) {
                    try {
                        const contactInfo = await sock.getBusinessProfile(remoteJid);
                        if (contactInfo && contactInfo.business_name) {
                            profileName = contactInfo.business_name;
                            console.log(`🏢 Nome do negócio encontrado para ${phone}: ${profileName}`);
                        }
                    } catch (error) {
                        console.log(`🏢 Sem nome de negócio para ${phone}: ${error.message}`);
                    }
                }
                
                let messageText = '';
                let messageType = 'texto';
                let mediaUrl = null;
                let mediaFilename = null;
                
                // Processa diferentes tipos de mensagem
                if (message.message?.conversation) {
                    messageText = message.message.conversation;
                } else if (message.message?.extendedTextMessage?.text) {
                    messageText = message.message.extendedTextMessage.text;
                } else if (message.message?.imageMessage) {
                    messageType = 'image';
                    messageText = message.message.imageMessage.caption || '[IMAGEM]';
                    mediaUrl = await downloadAndSaveMedia(sock, message.message.imageMessage, 'image', empresaId);
                    mediaFilename = `image_${Date.now()}.jpg`;
                } else if (message.message?.audioMessage) {
                    messageType = 'audio';
                    messageText = '[ÁUDIO]';
                    mediaUrl = await downloadAndSaveMedia(sock, message.message.audioMessage, 'audio', empresaId);
                    mediaFilename = `audio_${Date.now()}.ogg`;
                } else if (message.message?.videoMessage) {
                    messageType = 'video';
                    messageText = message.message.videoMessage.caption || '[VÍDEO]';
                    mediaUrl = await downloadAndSaveMedia(sock, message.message.videoMessage, 'video', empresaId);
                    mediaFilename = `video_${Date.now()}.mp4`;
                } else if (message.message?.documentMessage) {
                    messageType = 'document';
                    messageText = '[DOCUMENTO]';
                    mediaUrl = await downloadAndSaveMedia(sock, message.message.documentMessage, 'document', empresaId);
                    mediaFilename = message.message.documentMessage.fileName || `document_${Date.now()}`;
                } else {
                    messageText = '[MENSAGEM NÃO SUPORTADA]';
                }
                
                // Envia para o webhook do Flask
                await sendToWebhook(empresaId, phone, messageText, messageType, mediaUrl, mediaFilename, profileName, profilePicture);
                
            } catch (error) {
                console.error(`❌ Erro ao processar mensagem para empresa ${empresaId}:`, error);
            }
        });

        // Conexão já foi armazenada acima, não duplicar
        
    } catch (error) {
        console.error(`❌ Erro ao conectar WhatsApp para empresa ${empresaId}:`, error);
        updateConnectionStatus(empresaId, 'erro');
    }
}

/**
 * Baixa e salva mídia
 */
async function downloadAndSaveMedia(sock, mediaMessage, type, empresaId) {
    try {
        console.log(`📥 Baixando mídia do tipo: ${type}`);
        
        let buffer;
        
        // Tratamento especial para áudio
        if (type === 'audio') {
            try {
                // Tentar método padrão primeiro
                buffer = await downloadMediaMessage(
                    sock,
                    mediaMessage,
                    'buffer'
                );
            } catch (error) {
                console.log('⚠️ Método padrão falhou para áudio, tentando alternativo...');
                try {
                    // Tentar sem o socket como primeiro parâmetro
                    buffer = await downloadMediaMessage(
                        mediaMessage,
                        'buffer'
                    );
                } catch (error2) {
                    console.log('⚠️ Método alternativo também falhou para áudio');
                    // Para áudio, continuar sem o arquivo mas marcar como recebido
                    return `/static/uploads/whatsapp/audios/audio_${Date.now()}.ogg`;
                }
            }
        } else {
            // Para outros tipos de mídia, usar método padrão
            buffer = await downloadMediaMessage(
                sock,
                mediaMessage,
                'buffer'
            );
        }
        
        // Define extensão baseada no tipo
        let extension = '';
        switch (type) {
            case 'image':
                extension = '.jpg';
                break;
            case 'audio':
                extension = '.ogg';
                break;
            case 'video':
                extension = '.mp4';
                break;
            case 'document':
                extension = mediaMessage.fileName ? path.extname(mediaMessage.fileName) : '.bin';
                break;
        }
        
        // Verificar se o buffer foi obtido com sucesso
        if (!buffer) {
            console.log(`⚠️ Buffer vazio para ${type}, retornando URL placeholder`);
            const filename = `${type}_${Date.now()}_placeholder${extension}`;
            return `/static/uploads/whatsapp/${type === 'document' ? 'documents' : `${type}s`}/${filename}`;
        }
        
        // Gera nome único
        const filename = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${extension}`;
        const filepath = path.join(UPLOAD_DIR, type === 'document' ? 'documents' : `${type}s`, filename);
        
        // Salva arquivo
        fs.writeFileSync(filepath, buffer);
        console.log(`✅ Mídia salva: ${filepath}`);
        
        // Retorna URL relativa
        const mediaUrl = `/static/uploads/whatsapp/${type === 'document' ? 'documents' : `${type}s`}/${filename}`;
        console.log(`🔗 URL da mídia: ${mediaUrl}`);
        return mediaUrl;
        
    } catch (error) {
        console.error('❌ Erro ao baixar mídia:', error.message);
        return null;
    }
}

/**
 * Envia mensagem para o webhook do Flask
 */
async function sendToWebhook(empresaId, phone, message, messageType, mediaUrl, mediaFilename, profileName = null, profilePicture = null) {
    try {
        const webhookData = {
            empresa_id: empresaId,
            phone: phone,
            message: message,
            message_type: messageType,
            media_url: mediaUrl,
            media_filename: mediaFilename,
            profile_name: profileName,
            profile_picture: profilePicture
        };
        
        const response = await axios.post(`${FLASK_APP_URL}/webhook/whatsapp`, webhookData, {
            timeout: 10000
        });
        
        if (response.status === 200) {
            console.log(`✅ Mensagem enviada para webhook: ${phone} - ${message.substring(0, 50)}...`);
        }
        
    } catch (error) {
        console.error('❌ Erro ao enviar para webhook:', error);
    }
}

/**
 * Atualiza status de conexão no banco e notifica o Flask
 */
async function updateConnectionStatus(empresaId, status, qrCode = null) {
    try {
        const statusData = {
            empresa_id: empresaId,
            status_conexao: status,
            qr_code: qrCode,
            ultima_conexao: new Date().toISOString()
        };
        
        console.log(`📊 Status atualizado para empresa ${empresaId}: ${status}`);
        
        // Notificar Flask sobre mudança de status
        try {
            await axios.post(`${FLASK_APP_URL}/api/whatsapp/webhook/status`, {
                empresa_id: empresaId,
                status: status,
                qr_code: qrCode,
                timestamp: new Date().toISOString()
            }, {
                timeout: 5000
            });
            console.log(`✅ Flask notificado sobre status da empresa ${empresaId}`);
        } catch (webhookError) {
            console.error(`❌ Erro ao notificar Flask:`, webhookError.message);
        }
        
    } catch (error) {
        console.error('Erro ao atualizar status:', error);
    }
}

/**
 * Envia mensagem via WhatsApp
 */
async function sendMessage(empresaId, phone, message) {
    try {
        const sock = connections.get(empresaId);
        if (!sock) {
            throw new Error(`Conexão não encontrada para empresa ${empresaId}`);
        }
        
        const jid = `${phone}@s.whatsapp.net`;
        
        await sock.sendMessage(jid, { text: message });
        
        console.log(`✅ Mensagem enviada para ${phone}: ${message.substring(0, 50)}...`);
        return { success: true };
        
    } catch (error) {
        console.error(`❌ Erro ao enviar mensagem para empresa ${empresaId}:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * Envia mídia via WhatsApp
 */
async function sendMedia(empresaId, phone, mediaType, filePath, caption = '') {
    try {
        const sock = connections.get(empresaId);
        if (!sock) {
            throw new Error(`Conexão não encontrada para empresa ${empresaId}`);
        }
        
        const jid = `${phone}@s.whatsapp.net`;
        
        // Lê o arquivo
        const fileBuffer = fs.readFileSync(filePath);
        
        let mediaMessage = {};
        
        switch (mediaType) {
            case 'image':
                mediaMessage = {
                    image: fileBuffer,
                    caption: caption
                };
                break;
            case 'audio':
                mediaMessage = {
                    audio: fileBuffer
                };
                break;
            case 'video':
                mediaMessage = {
                    video: fileBuffer,
                    caption: caption
                };
                break;
            case 'document':
                mediaMessage = {
                    document: fileBuffer,
                    fileName: path.basename(filePath),
                    caption: caption
                };
                break;
            default:
                throw new Error(`Tipo de mídia não suportado: ${mediaType}`);
        }
        
        await sock.sendMessage(jid, mediaMessage);
        
        console.log(`✅ Mídia enviada para ${phone}: ${mediaType}`);
        return { success: true };
        
    } catch (error) {
        console.error(`❌ Erro ao enviar mídia para empresa ${empresaId}:`, error);
        return { success: false, error: error.message };
    }
}

// ============= ROTAS API =============

/**
 * Inicializar conexão para uma empresa
 */
app.post('/connect/:empresaId', async (req, res) => {
    try {
        const empresaId = req.params.empresaId;
        
        console.log(`🔌 Solicitação de conexão para empresa: ${empresaId}`);
        console.log(`   Headers:`, req.headers);
        console.log(`   Body:`, req.body);
        console.log(`   Query:`, req.query);
        console.log(`   Conexões existentes:`, Array.from(connections.keys()));
        
        // Sempre desconectar conexão existente antes de criar nova
        if (connections.has(empresaId)) {
            console.log(`🔄 Desconectando conexão existente para empresa ${empresaId}`);
            const sock = connections.get(empresaId);
            
            // Limpar timeout de reconexão se existir
            if (reconnectTimeouts.has(empresaId)) {
                clearTimeout(reconnectTimeouts.get(empresaId));
                reconnectTimeouts.delete(empresaId);
            }
            
            try {
                // Fechar conexão WebSocket primeiro
                if (sock.ws) {
                    sock.ws.close();
                }
                // Depois fazer logout
                await sock.logout();
            } catch (e) {
                console.log(`⚠️ Erro ao desconectar: ${e.message}`);
            }
            
            connections.delete(empresaId);
            qrCodes.delete(empresaId);
            reconnectAttempts.delete(empresaId);
            
            // Limpar arquivos de autenticação para forçar novo QR Code
            console.log(`🧹 Limpando arquivos de autenticação para empresa ${empresaId}`);
            await limparAuthEmpresa(empresaId);
        }
        
        console.log(`🚀 Iniciando nova conexão para empresa ${empresaId}`);
        await connectToWhatsApp(empresaId);
        
        res.json({ 
            success: true, 
            message: `Conexão iniciada para empresa ${empresaId}` 
        });
        
    } catch (error) {
        console.error(`❌ Erro ao conectar empresa ${req.params.empresaId}:`, error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Desconectar empresa
 */
app.post('/disconnect/:empresaId', async (req, res) => {
    try {
        const empresaId = req.params.empresaId;
        const sock = connections.get(empresaId);
        
        console.log(`🔌 Desconectando empresa ${empresaId}...`);
        
        if (sock) {
            // Limpar timeout de reconexão se existir
            if (reconnectTimeouts.has(empresaId)) {
                clearTimeout(reconnectTimeouts.get(empresaId));
                reconnectTimeouts.delete(empresaId);
            }
            
            try {
                // Fechar conexão WebSocket primeiro
                if (sock.ws) {
                    sock.ws.close();
                }
                // Depois fazer logout
                await sock.logout();
                console.log(`✅ Logout realizado para empresa ${empresaId}`);
            } catch (e) {
                console.log(`⚠️ Erro no logout: ${e.message}`);
            }
            
            connections.delete(empresaId);
            qrCodes.delete(empresaId);
            reconnectAttempts.delete(empresaId);
            updateConnectionStatus(empresaId, 'desconectado');
        }
        
        // Limpar arquivos de autenticação específicos da empresa
        await limparAuthEmpresa(empresaId);
        
        res.json({ 
            success: true, 
            message: `Empresa ${empresaId} desconectada` 
        });
        
    } catch (error) {
        console.error(`❌ Erro ao desconectar empresa ${req.params.empresaId}:`, error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Limpar arquivos de autenticação de uma empresa específica
 */
async function limparAuthEmpresa(empresaId) {
    try {
        const authDir = path.join(__dirname, 'auth_info', `empresa_${empresaId}`);
        if (fs.existsSync(authDir)) {
            console.log(`🗑️ Limpando auth para empresa ${empresaId}...`);
            fs.rmSync(authDir, { recursive: true, force: true });
            console.log(`✅ Auth removido para empresa ${empresaId}`);
        }
    } catch (error) {
        console.error(`Erro ao limpar auth da empresa ${empresaId}:`, error);
    }
}

/**
 * Limpar todas as conexões (para debug)
 */
app.post('/clear-all', async (req, res) => {
    try {
        console.log('🧹 Limpando todas as conexões...');
        
        // Limpar todos os timeouts de reconexão
        for (const [empresaId, timeoutId] of reconnectTimeouts) {
            clearTimeout(timeoutId);
        }
        reconnectTimeouts.clear();
        
        // Desconectar todas as conexões
        for (const [empresaId, sock] of connections) {
            try {
                // Fechar conexão WebSocket primeiro
                if (sock.ws) {
                    sock.ws.close();
                }
                // Depois fazer logout
                await sock.logout();
                console.log(`✅ Desconectado empresa ${empresaId}`);
            } catch (e) {
                console.log(`⚠️ Erro ao desconectar empresa ${empresaId}: ${e.message}`);
            }
        }
        
        // Limpar Maps
        connections.clear();
        qrCodes.clear();
        reconnectAttempts.clear();
        
        // Limpar arquivos de autenticação
        await limparArquivosAuth();
        
        res.json({ 
            success: true, 
            message: 'Todas as conexões foram limpas' 
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Limpar arquivos de autenticação
 */
async function limparArquivosAuth() {
    try {
        const authDir = path.join(__dirname, 'auth_info');
        if (fs.existsSync(authDir)) {
            console.log('🗑️ Limpando arquivos de autenticação...');
            
            // Listar todos os diretórios de empresas
            const empresas = fs.readdirSync(authDir);
            for (const empresa of empresas) {
                if (empresa.startsWith('empresa_')) {
                    const empresaDir = path.join(authDir, empresa);
                    try {
                        // Remover diretório completo
                        fs.rmSync(empresaDir, { recursive: true, force: true });
                        console.log(`✅ Removido auth para ${empresa}`);
                    } catch (e) {
                        console.log(`⚠️ Erro ao remover ${empresa}: ${e.message}`);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Erro ao limpar arquivos de auth:', error);
    }
}

/**
 * Enviar mensagem
 */
app.post('/send/:empresaId', async (req, res) => {
    try {
        const empresaId = req.params.empresaId;
        const { phone, message } = req.body;
        
        if (!phone || !message) {
            return res.status(400).json({ 
                success: false, 
                error: 'phone e message são obrigatórios' 
            });
        }
        
        // Validação de segurança: apenas números brasileiros
        if (!validarNumeroBrasileiro(phone)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Apenas números brasileiros são permitidos' 
            });
        }
        
        // Validação de sessão: verificar se a empresa está conectada
        if (!connections.has(empresaId)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Empresa não conectada ao WhatsApp' 
            });
        }
        
        const result = await sendMessage(empresaId, phone, message);
        res.json(result);
        
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Enviar mídia
 */
app.post('/send-media/:empresaId', async (req, res) => {
    try {
        const empresaId = req.params.empresaId;
        const { phone, media_type, file_path, caption } = req.body;
        
        if (!phone || !media_type || !file_path) {
            return res.status(400).json({ 
                success: false, 
                error: 'phone, media_type e file_path são obrigatórios' 
            });
        }
        
        const result = await sendMedia(empresaId, phone, media_type, file_path, caption);
        res.json(result);
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Status do QR Code para uma empresa (sem gerar QR manual)
 */
app.get('/qr-status/:empresaId', (req, res) => {
    const empresaId = req.params.empresaId;
    const qr = qrCodes.get(empresaId);
    const connection = connections.get(empresaId);

    console.log(`🔍 Status QR Code solicitado para empresa ${empresaId}:`);
    console.log(`   QR Code disponível:`, !!qr);
    console.log(`   Conexão ativa:`, !!connection);

    if (qr) {
        // Verificar se o QR Code é manual (falso) ou real do Baileys
        const isManualQR = qr.includes('manual_qr_code_for_testing');
        res.json({
            has_qr: true,
            is_manual: isManualQR,
            connected: false,
            message: isManualQR ? 'QR Code manual disponível (pode não funcionar)' : 'QR Code do WhatsApp disponível'
        });
    } else if (connection) {
        const isReallyConnected = connection.user && connection.user.id;
        if (isReallyConnected) {
            res.json({
                has_qr: false,
                connected: true,
                message: 'WhatsApp já conectado'
            });
        } else {
            res.json({
                has_qr: false,
                connected: false,
                is_waiting: true,
                message: 'Aguardando QR Code do WhatsApp'
            });
        }
    } else {
        res.status(400).json({
            has_qr: false,
            connected: false,
            error: 'Nenhuma conexão ativa',
            message: 'É necessário conectar ao WhatsApp primeiro'
        });
    }
});

/**
 * Status das conexões
 */
app.get('/status', (req, res) => {
    const status = {};
    
    console.log(`📊 Status solicitado - Conexões ativas: ${connections.size}`);
    console.log(`📊 Empresas conectadas:`, Array.from(connections.keys()));
    
    connections.forEach((sock, empresaId) => {
        const isConnected = sock.user && sock.user.id;
        const connectionState = sock.ws ? sock.ws.readyState : 'unknown';
        console.log(`📊 Empresa ${empresaId}: ${isConnected ? 'Conectada' : 'Desconectada'} (WebSocket: ${connectionState})`);
        
        status[empresaId] = {
            connected: isConnected,
            user: sock.user ? {
                id: sock.user.id,
                name: sock.user.name
            } : null,
            websocket_state: connectionState
        };
    });
    
    res.json({
        success: true,
        connections: status,
        total: connections.size
    });
});

/**
 * Endpoint de segurança
 */
app.get('/security/status', (req, res) => {
    try {
        const authDir = path.join(__dirname, 'auth_info');
        const empresas = fs.existsSync(authDir) ? fs.readdirSync(authDir) : [];
        
        const securityStatus = {
            allowed_countries: ALLOWED_COUNTRIES,
            max_phone_length: MAX_PHONE_LENGTH,
            min_phone_length: MIN_PHONE_LENGTH,
            protected_directories: empresas.length,
            active_connections: connections.size,
            security_features: [
                'Filtro por país (apenas Brasil)',
                'Validação de DDD brasileiro',
                'Proteção de diretórios de auth',
                'Logs de auditoria',
                'Middleware de segurança',
                'Validação de sessão'
            ]
        };
        
        res.json({
            success: true,
            security: securityStatus
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Teste de perfil
 */
app.get('/test-profile/:empresaId/:phone', async (req, res) => {
    try {
        const empresaId = req.params.empresaId;
        const phone = req.params.phone;
        const remoteJid = `${phone}@s.whatsapp.net`;
        
        console.log(`🧪 Testando perfil para ${phone} (empresa ${empresaId})`);
        
        if (!connections.has(empresaId)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Empresa não conectada' 
            });
        }
        
        const sock = connections.get(empresaId);
        let profileName = null;
        let profilePicture = null;
        
        try {
            // Buscar foto de perfil
            const profile = await sock.profilePictureUrl(remoteJid, 'image');
            if (profile) {
                profilePicture = profile;
                console.log(`📸 Foto de perfil encontrada: ${profile}`);
            }
        } catch (error) {
            console.log(`📸 Erro ao buscar foto: ${error.message}`);
        }
        
        try {
            // Buscar informações do contato
            const contact = await sock.onWhatsApp(remoteJid);
            if (contact && contact[0]) {
                profileName = contact[0].name || contact[0].notify || null;
                console.log(`👤 Nome encontrado: ${profileName}`);
            }
        } catch (error) {
            console.log(`👤 Erro ao buscar nome: ${error.message}`);
        }
        
        res.json({
            success: true,
            phone: phone,
            profile_name: profileName,
            profile_picture: profilePicture
        });
        
    } catch (error) {
        console.error('❌ Erro no teste de perfil:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Health check
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'whatsapp-baileys-multitenant',
        connections: connections.size,
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

// Render health check endpoint
app.get('/render-health', (req, res) => {
    res.json({ 
        status: 'healthy',
        service: 'whatsapp-api',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        connections: connections.size
    });
});

// Endpoint para obter QR Code de uma empresa
app.get('/qr/:empresaId', (req, res) => {
    const empresaId = req.params.empresaId;
    const qr = qrCodes.get(empresaId);
    const connection = connections.get(empresaId);

    console.log(`🔍 QR Code solicitado para empresa ${empresaId}:`);
    console.log(`   QR Code disponível:`, !!qr);
    console.log(`   Conexão ativa:`, !!connection);
    console.log(`   QR Codes armazenados:`, Array.from(qrCodes.keys()));
    console.log(`   Conexões ativas:`, Array.from(connections.keys()));

    if (qr) {
        // Verificar se o QR Code é manual (falso) ou real do Baileys
        const isManualQR = qr.includes('manual_qr_code_for_testing');
        console.log(`✅ Retornando QR Code para empresa ${empresaId} (${isManualQR ? 'MANUAL' : 'REAL'})`);
        res.json({
            qr: qr,
            connected: false,
            is_manual: isManualQR,
            message: isManualQR ? 'QR Code gerado manualmente - pode não funcionar para conexão' : 'QR Code válido do WhatsApp'
        });
    } else if (connection) {
        // Verificar se a conexão está realmente conectada ou apenas em estado "connecting"
        const isReallyConnected = connection.user && connection.user.id;
        console.log(`🔍 Conexão existe, mas está realmente conectada?`, isReallyConnected);

        if (isReallyConnected) {
            console.log(`✅ Empresa ${empresaId} já conectada`);
            res.json({
                qr: null,
                connected: true,
                message: 'WhatsApp já conectado'
            });
        } else {
            console.log(`⏳ Conexão existe mas não está conectada - aguardando QR Code do WhatsApp...`);
            // Em vez de gerar QR manual imediatamente, vamos aguardar um pouco mais
            res.json({
                qr: null,
                connected: false,
                is_waiting: true,
                message: 'Aguardando QR Code do WhatsApp... Tente novamente em alguns segundos'
            });
        }
    } else {
        console.log(`❌ Nenhuma conexão ou QR Code para empresa ${empresaId} - é necessário conectar primeiro`);
        res.status(400).json({
            qr: null,
            connected: false,
            error: 'Nenhuma conexão ativa',
            message: 'É necessário conectar ao WhatsApp primeiro. Use POST /connect/:empresaId'
        });
    }
});


// ============= INICIALIZAÇÃO =============

console.log("🚀 Iniciando WhatsApp Baileys Multi-Tenant...");
console.log(`📱 Servidor rodando na porta ${PORT}`);
console.log(`🔗 Flask URL: ${FLASK_APP_URL}`);
console.log(`📁 Upload dir: ${UPLOAD_DIR}`);

// Inicia servidor
app.listen(PORT, () => {
    console.log(`✅ Servidor Baileys iniciado na porta ${PORT}`);
    console.log("📋 Endpoints disponíveis:");
    console.log(`  POST /connect/:empresaId - Conectar empresa`);
    console.log(`  POST /disconnect/:empresaId - Desconectar empresa`);
    console.log(`  POST /send/:empresaId - Enviar mensagem`);
    console.log(`  POST /send-media/:empresaId - Enviar mídia`);
    console.log(`  GET /status - Status das conexões`);
    console.log(`  GET /qr-status/:empresaId - Status do QR Code (sem gerar QR manual)`);
    console.log(`  GET /qr/:empresaId - Obter QR Code`);
    console.log(`  GET /health - Health check`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🔄 Desconectando todas as empresas...');
    
    // Limpar todos os timeouts de reconexão
    for (const [empresaId, timeoutId] of reconnectTimeouts) {
        clearTimeout(timeoutId);
    }
    
    for (const [empresaId, sock] of connections) {
        try {
            // Fechar conexão WebSocket primeiro
            if (sock.ws) {
                sock.ws.close();
            }
            // Depois fazer logout
            await sock.logout();
            console.log(`✅ Empresa ${empresaId} desconectada`);
        } catch (error) {
            console.error(`❌ Erro ao desconectar empresa ${empresaId}:`, error);
        }
    }
    
    console.log('👋 Servidor finalizado');
    process.exit(0);
});
