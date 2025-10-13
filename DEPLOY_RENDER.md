# 🚀 Deploy da API WhatsApp no Render

Este guia explica como fazer o deploy da aplicação Node.js WhatsApp API no Render.

## 📋 Pré-requisitos

- Conta no [Render](https://render.com)
- Repositório Git (GitHub, GitLab, etc.)
- Domínio configurado (opcional)

## 🔧 Configuração no Render

### 1. Criar Novo Serviço Web

1. Acesse o [Dashboard do Render](https://dashboard.render.com)
2. Clique em "New +" → "Web Service"
3. Conecte seu repositório Git
4. Configure as seguintes opções:

```
Name: whatsapp-api
Environment: Node
Region: Oregon (US West)
Branch: main
Root Directory: node_whatsapp
```

### 2. Configurações de Build

```
Build Command: npm install
Start Command: npm start
```

### 3. Variáveis de Ambiente

Adicione as seguintes variáveis de ambiente no painel do Render:

```env
NODE_ENV=production
PORT=10000
FLASK_APP_URL=https://www.suaagenda.fun
WHATSAPP_API_URL_PRODUCTION=https://api.suaagenda.fun
CORS_ORIGIN=https://www.suaagenda.fun
```

### 4. Configurações Avançadas

#### Plano de Serviço
- **Starter**: $7/mês (recomendado para desenvolvimento)
- **Standard**: $25/mês (recomendado para produção)

#### Disco Persistente
- **Nome**: whatsapp-sessions
- **Caminho**: `/opt/render/project/src/auth_info`
- **Tamanho**: 1GB (suficiente para sessões WhatsApp)

#### Health Check
- **Path**: `/health`
- **Interval**: 30 segundos
- **Timeout**: 5 segundos

## 🌐 Configuração de Domínio

### 1. Domínio Personalizado

1. No painel do Render, vá em "Settings" → "Custom Domains"
2. Adicione seu domínio: `api.suaagenda.fun`
3. Configure os DNS records:

```
Type: CNAME
Name: api
Value: [seu-servico].onrender.com
```

### 2. SSL/TLS

O Render fornece SSL automático para domínios personalizados.

## 🔒 Configurações de Segurança

### 1. CORS

A aplicação já está configurada para aceitar apenas requisições do domínio principal:

```javascript
origin: process.env.CORS_ORIGIN || 'https://www.suaagenda.fun'
```

### 2. Rate Limiting

Configure rate limiting no Render ou use um proxy como Cloudflare.

### 3. Variáveis Sensíveis

Nunca commite arquivos `.env` com dados sensíveis. Use apenas as variáveis de ambiente do Render.

## 📊 Monitoramento

### 1. Logs

Acesse os logs em tempo real no painel do Render:
- **Deploy Logs**: Logs do processo de build
- **Live Logs**: Logs da aplicação em execução

### 2. Métricas

O Render fornece métricas básicas:
- CPU Usage
- Memory Usage
- Network I/O
- Disk I/O

### 3. Alertas

Configure alertas para:
- Falhas de deploy
- Alto uso de CPU/Memória
- Erros de aplicação

## 🔄 Deploy Automático

### 1. Auto-Deploy

O Render faz deploy automático quando você faz push para a branch `main`.

### 2. Deploy Manual

Para fazer deploy manual:
1. Vá em "Deploys" no painel do Render
2. Clique em "Deploy latest commit"

### 3. Rollback

Para fazer rollback:
1. Vá em "Deploys"
2. Clique no deploy anterior
3. Clique em "Promote to production"

## 🐛 Troubleshooting

### 1. Erro de Build

```bash
# Verificar logs de build
# Verificar se todas as dependências estão no package.json
npm install --production
```

### 2. Erro de Inicialização

```bash
# Verificar variáveis de ambiente
# Verificar se a porta está configurada corretamente
# Verificar se os diretórios necessários existem
```

### 3. Erro de Conexão

```bash
# Verificar CORS
# Verificar se o domínio está configurado corretamente
# Verificar se o SSL está funcionando
```

## 📱 Teste Pós-Deploy

### 1. Health Check

```bash
curl https://api.suaagenda.fun/health
```

### 2. Status da API

```bash
curl https://api.suaagenda.fun/status
```

### 3. Teste de CORS

```bash
curl -H "Origin: https://www.suaagenda.fun" \
     -H "Access-Control-Request-Method: GET" \
     -H "Access-Control-Request-Headers: X-Requested-With" \
     -X OPTIONS \
     https://api.suaagenda.fun/status
```

## 🔧 Comandos Úteis

### 1. Logs em Tempo Real

```bash
# No painel do Render, vá em "Live Logs"
```

### 2. Reiniciar Serviço

```bash
# No painel do Render, vá em "Manual Deploy"
```

### 3. Verificar Status

```bash
# No painel do Render, vá em "Metrics"
```

## 📞 Suporte

- **Render Docs**: https://render.com/docs
- **Render Support**: https://render.com/support
- **GitHub Issues**: [Seu repositório]/issues

## 🎯 Próximos Passos

1. ✅ Fazer deploy no Render
2. ✅ Configurar domínio personalizado
3. ✅ Testar todas as funcionalidades
4. ✅ Configurar monitoramento
5. ✅ Configurar backup das sessões WhatsApp
