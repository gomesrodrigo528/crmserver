# WhatsApp Multi-Tenant Server

Servidor Node.js com Baileys que permite gerenciar múltiplas conexões WhatsApp simultaneamente através de um sistema multi-tenant.

## ✅ Integração com Flask

Este servidor foi atualizado para ser **100% compatível** com o servidor Flask do sistema Sua Agenda. O Flask faz as seguintes chamadas para o Node.js:

- `POST /send/{empresa_id}` - Para enviar mensagens
- `POST /webhook/whatsapp` - Webhook para receber mensagens

## Funcionalidades

- ✅ **Multi-Tenant**: Gerencia múltiplas conexões WhatsApp independentes
- ✅ **Flask Integration**: APIs compatíveis com o servidor Flask
- ✅ **QR Code**: Gera QR codes únicos para cada empresa
- ✅ **Auto-reconexão**: Reconexão automática em caso de desconexão
- ✅ **Webhook Bidirecional**: Comunicação entre Node.js e Flask
- ✅ **Estado Persistente**: Salva autenticação por empresa em diretórios separados
- ✅ **REST API**: APIs completas para gerenciar tenants e enviar mensagens

## Instalação

1. Instale as dependências:
```bash
npm install
```

2. Execute o servidor:
```bash
npm run start-baileys
```

## 🔗 APIs para Flask (Principais)

### Enviar Mensagem via Empresa
```http
POST /send/{empresa_id}
Content-Type: application/json

{
  "phone": "5511999999999",
  "message": "Olá! Esta é uma mensagem de teste."
}
```

### Webhook (recebe do Flask)
```http
POST /webhook
Content-Type: application/json

{
  "phone": "5511999999999",
  "message": "Texto da mensagem",
  "message_type": "texto",
  "empresa_id": 1
}
```

## 🔗 APIs Multi-Tenant (Completas)

### Gerenciamento de Tenants

#### Listar todos os tenants
```http
GET /tenants
```

#### Criar um novo tenant
```http
POST /tenants
Content-Type: application/json

{
  "tenantId": "empresa1"
}
```

#### Obter QR code para um tenant
```http
GET /tenants/{tenantId}/qr
```

#### Verificar status de um tenant
```http
GET /tenants/{tenantId}/status
```

#### Desconectar um tenant
```http
DELETE /tenants/{tenantId}
```

#### Enviar mensagem via tenant específico
```http
POST /tenants/{tenantId}/send
Content-Type: application/json

{
  "phone": "5511999999999",
  "message": "Olá! Esta é uma mensagem de teste."
}
```

### Informações Gerais

#### Status geral do servidor
```http
GET /status
```

#### Health check
```http
GET /health
```

## 🚀 Como Usar com Flask

### 1. Configuração no Flask

No arquivo `.env` do Flask, configure:
```bash
WHATSAPP_API_URL=http://localhost:4000
WHATSAPP_API_URL_PRODUCTION=https://seu-dominio.com
```

### 2. Iniciar o Sistema

```bash
# Terminal 1 - Flask
cd flask_app
python main.py

# Terminal 2 - Node.js WhatsApp
cd node_whatsapp
npm run start-baileys
```

### 3. Criar Empresa/Tenant

```bash
# Via Node.js API
curl -X POST http://localhost:4000/tenants \
  -H "Content-Type: application/json" \
  -d '{"tenantId": "1"}'

# Ou via Flask (se houver interface)
# O Flask pode criar tenants automaticamente
```

### 4. Conectar WhatsApp

```bash
# Obter QR code
curl http://localhost:4000/tenants/1/qr

# Escanear o QR code no WhatsApp
# Verificar status
curl http://localhost:4000/tenants/1/status
```

### 5. Enviar Mensagem

```bash
# Via API Node.js
curl -X POST http://localhost:4000/send/1 \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "5511999999999",
    "message": "Olá! Mensagem via API Node.js"
  }'

# Via Flask (o Flask chamará o Node.js)
curl -X POST http://localhost:5000/api/whatsapp/send \
  -H "Content-Type: application/json" \
  -d '{
    "chat_id": 1,
    "message": "Olá! Mensagem via Flask"
  }'
```

## 🔄 Fluxo de Funcionamento

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   WhatsApp  │───▶│  Node.js    │───▶│   Flask     │
│             │    │  (Porta     │    │  (Porta     │
│             │    │   4000)     │    │   5000)     │
└─────────────┘    └─────────────┘    └─────────────┘
       │                   │                   │
       │                   │                   │
       ◀───────────────────┴───────────────────┘
```

1. **WhatsApp** envia mensagens para o Node.js
2. **Node.js** processa e envia para o webhook do Flask
3. **Flask** recebe via `/webhook/whatsapp` e salva no banco
4. **Flask** pode enviar mensagens fazendo POST para `/send/{empresa_id}`

## 🧪 Testes de Integração

Execute o teste completo de integração:

```bash
chmod +x test_flask_integration.sh
./test_flask_integration.sh
```

## 📊 Logs e Monitoramento

O servidor exibe logs detalhados:

- ✅ **Verde**: Operações bem-sucedidas
- ❌ **Vermelho**: Erros
- 🔄 **Azul**: Reconexões
- 📱 **Ciano**: QR Codes
- 📨 **Amarelo**: Mensagens

Exemplo de log:
```
✅ Tenant 1 inicializado
📱 QR Code gerado para tenant 1
✅ [1] Conectado ao WhatsApp!
📨 [1] Mensagem recebida de 5511999999999: Olá
✅ [1] Webhook enviado para API interna: 5511999999999
✅ Webhook enviado para Flask: 5511999999999
```

## 🔧 Configurações

As configurações podem ser ajustadas no código:

```javascript
const FLASK_URL = "http://127.0.0.1:5000";  // URL do Flask
const PORT = 4000;                           // Porta do Node.js
const AUTH_DIR = 'auth';                     // Diretório de auth
```

## 🐛 Troubleshooting

### Flask não consegue conectar ao Node.js
1. Verifique se ambos os servidores estão rodando
2. Confirme as URLs em `WHATSAPP_API_URL`
3. Teste com: `curl http://localhost:4000/health`

### QR Code não aparece
1. Verifique logs do Node.js
2. Tente: `curl http://localhost:4000/tenants/1/qr`
3. Reinicie o tenant: `curl -X DELETE http://localhost:4000/tenants/1`

### Loops de Reconexão
Se o sistema ficar em loop de tentativas de reconexão:

1. **Limpar todas as conexões:**
```bash
curl -X POST http://localhost:4000/clear-all
```

2. **Reinicializar empresa específica:**
```bash
curl -X POST http://localhost:4000/restart/365
```

3. **Reset completo do sistema:**
```bash
./reset_whatsapp.sh  # Script de reset automático
```

4. **Verificar logs detalhados:**
```bash
./debug_whatsapp.sh  # Script de debug
```

### Causas comuns de loops:
- ❌ **QR Code expirado** - O usuário não escaneou o QR a tempo
- ❌ **Problemas de rede** - Conexão instável com WhatsApp
- ❌ **Limite de tentativas** - Sistema tentando reconectar automaticamente
- ❌ **Flask não respondendo** - Webhook não consegue enviar para Flask

### Solução:
1. Use `POST /clear-all` para limpar todas as conexões
2. Reconecte via interface web: http://localhost:5000/configuracao
3. Monitore os logs para identificar a causa específica

## 🎯 APIs Debug (Novas)

### Limpeza e Reset
```http
POST /clear-all
# Limpa todas as conexões e reinicia o sistema
```

```http
POST /restart/{empresaId}
# Reinicializa uma empresa específica
```

### Verificação de Status
```http
GET /status
# Status geral com todas as conexões
```

```http
GET /health
# Health check básico
## 🛠️ Scripts de Automação

O sistema inclui scripts para facilitar o debug e manutenção:

### Scripts Disponíveis

#### `debug_whatsapp.sh`
Script para verificar status dos servidores e conexões:
```bash
chmod +x debug_whatsapp.sh
./debug_whatsapp.sh
```

**Funcionalidades:**
- ✅ Verifica se Flask e Node.js estão rodando
- ✅ Mostra status das conexões WhatsApp
- ✅ Lista comandos de debug disponíveis
- ✅ Fornece URLs e endpoints para teste

#### `reset_whatsapp.sh`
Script para reset completo do sistema:
```bash
chmod +x reset_whatsapp.sh
./reset_whatsapp.sh
```

**Funcionalidades:**
- ✅ Para todos os servidores
- ✅ Limpa conexões problemáticas
- ✅ Reinicia Flask e Node.js
- ✅ Fornece PIDs e URLs dos serviços

### Como Usar

1. **Debug rápido:**
```bash
./debug_whatsapp.sh
```

2. **Reset em caso de problemas:**
```bash
./reset_whatsapp.sh
```

3. **Limpeza manual:**
```bash
curl -X POST http://localhost:4000/clear-all
```

## 🎯 Diferenças do Sistema Anterior

| Funcionalidade | Antes | Agora |
|----------------|-------|-------|
| **Identificação** | tenantId | empresa_id |
| **API Envio** | `/tenants/{tenantId}/send` | `/send/{empresa_id}` |
| **Webhook** | Direto para Flask | Via API `/webhook` |
| **Multi-tenant** | ✅ | ✅ Melhorado |
| **Flask Integration** | ❌ | ✅ Completo |

O sistema está **100% compatível** com o Flask e mantém todas as funcionalidades multi-tenant!
