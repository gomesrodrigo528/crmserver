// Configurações do WhatsApp Multi-Tenant Server
export const CONFIG = {
  // Servidor
  PORT: process.env.PORT || 4000,
  HOST: process.env.HOST || '0.0.0.0',

  // Flask Integration
  FLASK_URL: process.env.FLASK_URL || 'https://suaagenda.fun',

  // Autenticação
  AUTH_DIR: process.env.AUTH_DIR || 'auth',

  // WhatsApp
  WHATSAPP: {
    RECONNECT_ATTEMPTS: 5,
    RECONNECT_DELAY: 5000, // ms
    BROWSER_NAME: 'WhatsApp-MultiTenant',
    BROWSER_VERSION: '1.0.0'
  },

  // Logs
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_COLORS: {
    success: '\x1b[32m', // Verde
    error: '\x1b[31m',   // Vermelho
    warning: '\x1b[33m', // Amarelo
    info: '\x1b[36m',    // Ciano
    reset: '\x1b[0m'     // Reset
  },

  // Rate Limiting
  RATE_LIMIT: {
    WINDOW_MS: 15 * 60 * 1000, // 15 minutos
    MAX_REQUESTS: 100 // requests por janela
  },

  // Timeouts
  TIMEOUTS: {
    QR_CODE_GENERATION: 10000, // 10s
    MESSAGE_SEND: 30000,       // 30s
    WEBHOOK: 10000             // 10s
  }
};

// Funções utilitárias
export const log = {
  success: (message) => console.log(`${CONFIG.LOG_COLORS.success}✅ ${message}${CONFIG.LOG_COLORS.reset}`),
  error: (message) => console.log(`${CONFIG.LOG_COLORS.error}❌ ${message}${CONFIG.LOG_COLORS.reset}`),
  warning: (message) => console.log(`${CONFIG.LOG_COLORS.warning}⚠️ ${message}${CONFIG.LOG_COLORS.reset}`),
  info: (message) => console.log(`${CONFIG.LOG_COLORS.info}ℹ️ ${message}${CONFIG.LOG_COLORS.reset}`),
  qr: (message) => console.log(`${CONFIG.LOG_COLORS.info}📱 ${message}${CONFIG.LOG_COLORS.reset}`),
  message: (message) => console.log(`${CONFIG.LOG_COLORS.warning}📨 ${message}${CONFIG.LOG_COLORS.reset}`),
  reconnect: (message) => console.log(`${CONFIG.LOG_COLORS.info}🔄 ${message}${CONFIG.LOG_COLORS.reset}`)
};
