#!/bin/bash
# Script de build para Render
# Este script é executado durante o processo de build no Render

echo "🚀 Iniciando build da aplicação WhatsApp API..."

# Verificar se estamos em produção
if [ "$NODE_ENV" = "production" ]; then
    echo "🌍 Ambiente: Produção"
else
    echo "🌍 Ambiente: Desenvolvimento"
fi

# Instalar dependências
echo "📦 Instalando dependências..."
npm ci --only=production

# Verificar se a instalação foi bem-sucedida
if [ $? -eq 0 ]; then
    echo "✅ Dependências instaladas com sucesso"
else
    echo "❌ Erro ao instalar dependências"
    exit 1
fi

# Criar diretórios necessários
echo "📁 Criando diretórios necessários..."
mkdir -p auth_info
mkdir -p static/uploads/whatsapp/images
mkdir -p static/uploads/whatsapp/audios
mkdir -p static/uploads/whatsapp/videos
mkdir -p static/uploads/whatsapp/documents
mkdir -p logs

# Verificar se os diretórios foram criados
if [ -d "auth_info" ] && [ -d "static" ]; then
    echo "✅ Diretórios criados com sucesso"
else
    echo "❌ Erro ao criar diretórios"
    exit 1
fi

# Verificar variáveis de ambiente críticas
echo "🔍 Verificando variáveis de ambiente..."
required_vars=("FLASK_APP_URL" "WHATSAPP_API_URL_PRODUCTION")
missing_vars=()

for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        missing_vars+=("$var")
    fi
done

if [ ${#missing_vars[@]} -eq 0 ]; then
    echo "✅ Todas as variáveis de ambiente estão configuradas"
else
    echo "❌ Variáveis de ambiente faltando: ${missing_vars[*]}"
    exit 1
fi

# Verificar se o arquivo principal existe
if [ -f "baileys_server_multitenant.js" ]; then
    echo "✅ Arquivo principal encontrado"
else
    echo "❌ Arquivo principal não encontrado"
    exit 1
fi

# Verificar se o script de start existe
if [ -f "start.js" ]; then
    echo "✅ Script de start encontrado"
else
    echo "❌ Script de start não encontrado"
    exit 1
fi

echo "🎉 Build concluído com sucesso!"
echo "📊 Informações do build:"
echo "   - Node.js: $(node --version)"
echo "   - NPM: $(npm --version)"
echo "   - Diretório: $(pwd)"
echo "   - Arquivos: $(ls -la | wc -l)"
