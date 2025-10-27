#!/usr/bin/env node
/**
 * Script de inicialização para Render
 * Configura o ambiente e inicia o servidor
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Carregar variáveis de ambiente
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🚀 Iniciando aplicação WhatsApp API no Render...');

// Verificar se estamos em produção
const isProduction = process.env.NODE_ENV === 'production';
console.log(`🌍 Ambiente: ${isProduction ? 'Produção' : 'Desenvolvimento'}`);

// Criar diretórios necessários se não existirem
const directories = [
    'auth_info',
    'static/uploads/whatsapp/images',
    'static/uploads/whatsapp/audios',
    'static/uploads/whatsapp/videos',
    'static/uploads/whatsapp/documents'
];

directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Diretório criado: ${dir}`);
    }
});

// Verificar variáveis de ambiente críticas
const requiredEnvVars = [
    'FLASK_APP_URL',
    'WHATSAPP_API_URL_PRODUCTION'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error('❌ Variáveis de ambiente obrigatórias não encontradas:');
    missingVars.forEach(varName => {
        console.error(`   - ${varName}`);
    });
    process.exit(1);
}

console.log('✅ Variáveis de ambiente verificadas');
console.log(`🔗 Flask URL: ${process.env.FLASK_APP_URL}`);
console.log(`🔗 WhatsApp API URL: ${process.env.WHATSAPP_API_URL_PRODUCTION}`);

// Configurar porta
const PORT = process.env.PORT || 3000;
console.log(`🌐 Porta configurada: ${PORT}`);

// Iniciar servidor
console.log('🎯 Iniciando servidor Baileys...');
import('./baileys_server_multitenant.js');

