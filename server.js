import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';

const PORT = Number(process.env.PORT || 3000);
const VERSAO = '1.8.8';
const AGENTE_URL =
  process.env.AGENTE_URL || 'https://xhu56j4zkwooh8hq9hy5.helloreaddy.com/functions/v1/wpp-agente';
const AGENTE_TOKEN = process.env.WPP_AGENT_TOKEN || '';
const INSTANCIA_PADRAO = process.env.WPP_INSTANCE || '';

// Relogio dos testes gratuitos: este servidor fica 24 horas no ar, entao e ele quem
// chama a rotina de corte (trial-guard) a cada 5 minutos, mesmo sem ninguem usando o site.
// O endereco e derivado do endereco do agente do painel (mesma base, outra funcao).
const GUARDIAO_URL =
  process.env.GUARDIAO_URL || `${String(AGENTE_URL).replace(/\/+$/, '').replace(/\/wpp-agente$/, '')}/trial-guard`;
const GUARDIAO_KEY = process.env.GUARDIAO_KEY || '';
const GUARDIAO_MINUTOS = Math.max(1, Math.min(60, Number(process.env.GUARDIAO_MINUTOS || 5) || 5));

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

function resolveAuthDir() {
  const preferido = process.env.WPP_AUTH_DIR || path.join('/var/data', 'auth');
  try {
    fs.mkdirSync(preferido, { recursive: true });
    fs.accessSync(preferido, fs.constants.W_OK);
    return preferido;
  } catch {
    const alternativa = path.join(process.cwd(), '.auth');
    fs.mkdirSync(alternativa, { recursive: true });
    return alternativa;
  }
}

const AUTH_DIR = resolveAuthDir();
const MAX_TENTATIVAS = 6;

const estado = {
  sock: null,
  conectado: false,
  iniciando: false,
  paradaManual: false,
  qr: null,
  qrAtualizadoEm: null,
  // Quando o codigo atual foi recebido do WhatsApp. Um QR do WhatsApp vale por
  // menos de 1 minuto; depois disso ele e recusado na leitura.
  qrCriadoEm: null,
  numero: null,
  nome: null,
  instancia: INSTANCIA_PADRAO,
  ultimoErro: null,
  iniciadoEm: new Date().toISOString(),
  mensagensRecebidas: 0,
  respostasEnviadas: 0,
  geracao: 0,
  tentativas: 0,
  timerReconexao: null,
  iniciandoEm: null,
  // Quando o socket foi criado. Um socket que passa de 12 segundos sem QR Code
  // nem conexao esta travado e precisa ser recriado.
  sockCriadoEm: null,
  // Momento em que o painel pediu um QR Code. Serve para o servidor insistir
  // sozinho ate o codigo aparecer, sem depender de novos cliques.
  qrSolicitadoEm: null,
  qrAnterior: null,
  // Momento em que um QR Code foi entregue ao painel. Durante a janela de vinculo
  // nada e apagado: era isso que cortava a leitura no meio.
  qrEntregueEm: null,
  // O WhatsApp entra em "connecting" depois que o codigo e lido, enquanto grava
  // a sessao. Nesse periodo a pasta de credenciais e sagrada.
  pareando: false,
  pareandoEm: null,
  // Conexao por codigo de 8 digitos (sem QR Code). Nesse modo o servidor NAO
  // mostra QR: ele entrega um codigo curto que o cliente digita no WhatsApp.
  modoCodigo: false,
  codigoPar: null,
  codigoParEm: null,
  codigoParNumero: null,
};

// Pedido de codigo aguardando a criacao do socket.
let pedidoCodigo = null;

let promessaInicio = null;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-wpp-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

function extrairTexto(message) {
  if (!message) return '';
  let interno = message;
  if (interno.ephemeralMessage?.message) interno = interno.ephemeralMessage.message;
  if (interno.viewOnceMessage?.message) interno = interno.viewOnceMessage.message;
  if (interno.viewOnceMessageV2?.message) interno = interno.viewOnceMessageV2.message;
  if (interno.documentWithCaptionMessage?.message) interno = interno.documentWithCaptionMessage.message;
  return (
    interno.conversation ||
    interno.extendedTextMessage?.text ||
    interno.imageMessage?.caption ||
    interno.videoMessage?.caption ||
    interno.documentMessage?.caption ||
    interno.buttonsResponseMessage?.selectedDisplayText ||
    interno.listResponseMessage?.title ||
    ''
  );
}

function somenteDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

// Codigo de conexao por telefone: o WhatsApp so aceita o codigo por pouco tempo
// depois de gerado. Vencido, ele responde no celular "Nao foi possivel conectar
// o dispositivo". Guardamos o prazo para o painel mostrar a contagem e pedir um
// codigo novo antes de o cliente digitar um codigo morto.
const CODIGO_VALIDADE_MS = 90000;

// "00 55", zero de operadora e zero de DDD fazem o vinculo falhar.
function normalizarNumero(valor) {
  let digitos = somenteDigitos(valor);
  digitos = digitos.replace(/^00+/, '');
  digitos = digitos.replace(/^0+/, '');
  return digitos;
}

function codigoParRestante() {
  const em = Date.parse(String(estado.codigoParEm || '')) || 0;
  if (!estado.codigoPar || !em) return 0;
  return Math.max(0, Math.round((CODIGO_VALIDADE_MS - (Date.now() - em)) / 1000));
}

// Vencido o prazo, o codigo sai da tela e o motivo fica explicito no painel.
function expirarCodigoVencido() {
  if (!estado.codigoPar) return;
  if (codigoParRestante() > 0) return;
  estado.codigoPar = null;
  estado.codigoParEm = null;
  estado.codigoParNumero = null;
  // Sai do modo codigo: assim o painel pode voltar ao QR Code ou pedir um
  // codigo novo sem ficar preso em "gerando codigo".
  estado.modoCodigo = false;
  estado.pareando = false;
  estado.pareandoEm = null;
}

// Controle de mensagens enviadas pelo painel: assim conseguimos diferenciar
// o que o painel enviou do que o dono digitou direto no celular.
const enviosProprios = new Map();
const textosProprios = new Map();
const ultimosEnviosPorNumero = new Map();
const JANELA_ENVIO_MS = 5 * 60 * 1000;
// Sempre que o servidor envia algo, o WhatsApp devolve o mesmo envio como se
// tivesse saído do celular. Nesse intervalo o evento é reconhecido como eco do
// próprio sistema e nunca é tratado como atendimento manual do dono — era isso
// que pausava a IA sozinha no meio do atendimento.
const JANELA_ECO_ENVIO_MS = 60 * 1000;
// O WhatsApp pode entregar o mesmo evento duas vezes. Sem esse controle a mesma
// mensagem gerava duas chamadas ao robô.
const mensagensProcessadas = new Map();
const JANELA_PROCESSADA_MS = 10 * 60 * 1000;

function chaveNumero(valor) {
  const digitos = somenteDigitos(valor);
  return digitos.length > 10 ? digitos.slice(-10) : digitos;
}

function limparEnviosAntigos() {
  const agora = Date.now();
  for (const [chave, quando] of enviosProprios) {
    if (agora - quando > JANELA_ENVIO_MS) enviosProprios.delete(chave);
  }
  for (const [chave, quando] of textosProprios) {
    if (agora - quando > JANELA_ENVIO_MS) textosProprios.delete(chave);
  }
  for (const [chave, quando] of ultimosEnviosPorNumero) {
    if (agora - quando > JANELA_ECO_ENVIO_MS) ultimosEnviosPorNumero.delete(chave);
  }
  for (const [chave, quando] of mensagensProcessadas) {
    if (agora - quando > JANELA_PROCESSADA_MS) mensagensProcessadas.delete(chave);
  }
}

function jaProcessada(id) {
  const chave = String(id || '').trim();
  if (!chave) return false;
  if (mensagensProcessadas.has(chave)) return true;
  mensagensProcessadas.set(chave, Date.now());
  limparEnviosAntigos();
  return false;
}

function registrarEnvioProprio(numero, texto, id) {
  const agora = Date.now();
  if (id) enviosProprios.set(String(id), agora);
  const chaveTexto = `${somenteDigitos(numero)}|${String(texto || '').slice(0, 120)}`;
  if (chaveTexto.length > 2) textosProprios.set(chaveTexto, agora);
  const numeroChave = chaveNumero(numero);
  if (numeroChave.length >= 8) ultimosEnviosPorNumero.set(numeroChave, agora);
  limparEnviosAntigos();
}

function foiEnviadoPeloPainel(numero, texto, id) {
  const agora = Date.now();
  if (id && enviosProprios.has(String(id))) return true;
  // Proteção contra a corrida entre o envio do painel e o evento do WhatsApp.
  const chaveTexto = `${somenteDigitos(numero)}|${String(texto || '').slice(0, 120)}`;
  const quandoTexto = textosProprios.get(chaveTexto);
  if (quandoTexto && agora - quandoTexto < 90000) return true;
  // Última rede de segurança: acabamos de enviar algo para este número, então o
  // evento é o eco do nosso próprio envio e não atendimento manual.
  const quandoNumero = ultimosEnviosPorNumero.get(chaveNumero(numero));
  if (quandoNumero && agora - quandoNumero < JANELA_ECO_ENVIO_MS) return true;
  return false;
}

function extrairTipoMidia(message) {
  if (!message) return '';
  let interno = message;
  if (interno.ephemeralMessage?.message) interno = interno.ephemeralMessage.message;
  if (interno.viewOnceMessage?.message) interno = interno.viewOnceMessage.message;
  if (interno.viewOnceMessageV2?.message) interno = interno.viewOnceMessageV2.message;
  if (interno.documentWithCaptionMessage?.message) interno = interno.documentWithCaptionMessage.message;
  if (interno.imageMessage) return 'image';
  if (interno.stickerMessage) return 'sticker';
  if (interno.videoMessage) return 'video';
  if (interno.audioMessage || interno.pttMessage) return 'audio';
  if (interno.documentMessage) return 'document';
  return '';
}

function arquivoCredenciais() {
  return path.join(AUTH_DIR, 'creds.json');
}

function credenciaisValidas() {
  try {
    const arquivo = arquivoCredenciais();
    if (!fs.existsSync(arquivo)) return false;
    const bruto = fs.readFileSync(arquivo, 'utf8').trim();
    if (!bruto) return false;
    const dados = JSON.parse(bruto);
    if (!dados || typeof dados !== 'object') return false;
    if (dados.registered === false) return false;
    if (!dados.noiseKey || !dados.signedIdentityKey) return false;
    return true;
  } catch {
    return false;
  }
}

// Uma leitura de QR Code pode levar alguns minutos (o cliente abre o WhatsApp,
// procura Dispositivos conectados, aponta a camera). Nada aqui pode apagar a
// sessao enquanto isso: era exatamente esse corte que fazia o WhatsApp mostrar
// o aparelho conectado e o servidor voltar para "aguardando QR".
const JANELA_VINCULO_MS = 3 * 60 * 1000;

function vinculoEmAndamento() {
  if (estado.pareando) {
    const desde = Number(estado.pareandoEm || 0);
    if (!desde || Date.now() - desde < JANELA_VINCULO_MS) return true;
    estado.pareando = false;
    estado.pareandoEm = null;
  }
  const entregue = Number(estado.qrEntregueEm || 0);
  return entregue > 0 && Date.now() - entregue < JANELA_VINCULO_MS;
}

function limparSessaoSeSeguro() {
  if (vinculoEmAndamento()) return false;
  limparSessao();
  return true;
}

// Um QR do WhatsApp vale por poucos segundos. Codigo vencido e recusado no
// celular, entao ele e descartado e um novo e pedido sozinho.
const QR_VALIDADE_MS = 80000;

function descartarQrVencido() {
  if (!estado.qr || estado.conectado) return;
  // Codigo entregue ha pouco (ou sendo lido): nao recomecar a sessao agora.
  if (vinculoEmAndamento()) return;
  const criado = Number(estado.qrCriadoEm || 0);
  if (!criado) return;
  if (Date.now() - criado < QR_VALIDADE_MS) return;
  estado.qr = null;
  estado.qrAnterior = null;
  estado.qrCriadoEm = null;
  estado.qrAtualizadoEm = null;
  estado.qrSolicitadoEm = estado.qrSolicitadoEm || Date.now();
  if (!estado.iniciando) {
    encerrarSocketAtual();
    void iniciarConexao();
  }
}

function statusConexao() {
  if (estado.conectado) return 'connected';
  if (estado.qr) return 'qr';
  if (estado.iniciando || estado.sock) return 'connecting';
  return 'disconnected';
}

// O painel informa o nome da conexão também nas consultas simples. Sem isso,
// depois de um reinicio do servidor a mensagem podia ser gravada na conexão de
// outra conta e não aparecia no painel.
function lerInstanciaDaConsulta(req) {
  const valor = String(req?.query?.instancia || req?.query?.instance || '').trim();
  if (valor) estado.instancia = valor;
}

function statusResumido() {
  descartarQrVencido();
  expirarCodigoVencido();
  const conectado = estado.conectado;
  return {
    ok: true,
    versao: VERSAO,
    conectado,
    status: statusConexao(),
    qr: conectado ? null : estado.qr,
    qr_atualizado_em: estado.qrAtualizadoEm,
    numero: estado.numero,
    nome: estado.nome,
    instancia: estado.instancia || null,
    erro: estado.ultimoErro,
    iniciando: estado.iniciando,
    aguardando_qr: Boolean(estado.qr),
    tentativas: estado.tentativas,
    sessao_salva: credenciaisValidas(),
    vinculo_em_andamento: vinculoEmAndamento(),
    modo_codigo: estado.modoCodigo,
    codigo_par: conectado ? null : estado.codigoPar,
    codigo_par_em: estado.codigoParEm,
    codigo_par_numero: estado.codigoParNumero,
    codigo_par_segundos: conectado ? 0 : codigoParRestante(),
    codigo_par_expirado: Boolean(estado.modoCodigo && !estado.codigoPar),
    mensagens_recebidas: estado.mensagensRecebidas,
    respostas_enviadas: estado.respostasEnviadas,
  };
}

async function falarComAgente(payload, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (AGENTE_TOKEN) headers['x-wpp-token'] = AGENTE_TOKEN;
    const resposta = await fetch(AGENTE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const texto = await resposta.text();
    try {
      return texto ? JSON.parse(texto) : null;
    } catch {
      return { ok: false, message: texto.slice(0, 300) };
    }
  } catch (erro) {
    return { ok: false, message: erro?.message || 'Falha ao falar com o agente do painel.' };
  } finally {
    clearTimeout(timer);
  }
}

async function enviarTexto(destino, texto) {
  if (!estado.sock || !estado.conectado) {
    throw new Error('O WhatsApp nao esta conectado.');
  }
  const bruto = String(destino ?? '').trim();
  const candidatos = [];
  if (bruto.includes('@')) {
    candidatos.push(bruto);
  } else {
    const digitos = somenteDigitos(bruto);
    if (digitos.length < 8) throw new Error('Numero de destino invalido.');
    // Contatos novos do WhatsApp chegam com identificador interno (LID),
    // por isso tentamos primeiro o formato @lid quando o numero tem esse tamanho.
    if (digitos.length >= 14) candidatos.push(`${digitos}@lid`);
    candidatos.push(`${digitos}@s.whatsapp.net`);
  }

  let ultimoErro = null;
  for (const jid of candidatos) {
    try {
      const enviada = await estado.sock.sendMessage(jid, { text: String(texto) });
      const idMensagem = enviada?.key?.id || '';
      registrarEnvioProprio(destino, texto, idMensagem);
      return { jid, id: idMensagem };
    } catch (erro) {
      ultimoErro = erro;
    }
  }
  throw ultimoErro || new Error('Falha ao enviar a mensagem.');
}

async function informarEnvio(numero, texto, enviada, erro) {
  try {
    await falarComAgente(
      {
        action: 'resposta_enviada',
        instancia: estado.instancia || undefined,
        instance: estado.instancia || undefined,
        numero,
        phone: numero,
        texto: String(texto || '').slice(0, 300),
        enviada,
        erro: enviada ? undefined : String(erro || 'erro desconhecido').slice(0, 200),
      },
      15000,
    );
  } catch {
    // O registro de status e apenas informativo.
  }
}

async function processarMensagemRecebida(msg) {
  try {
    if (!msg?.message) return;
    // O mesmo evento pode chegar repetido. Processar duas vezes duplicava a
    // chamada do robô e atrasava as outras mensagens.
    if (msg.key?.id && jaProcessada(msg.key.id)) return;
    const remoto = msg.key?.remoteJid || '';
    if (!remoto || remoto.endsWith('@g.us') || remoto === 'status@broadcast') return;

    const tipoMidia = extrairTipoMidia(msg.message);
    const texto = extrairTexto(msg.message).trim();

    // Mensagem enviada pelo próprio número conectado (celular ou WhatsApp Web do dono).
    // Se saiu pelo painel, ignoramos. Se o dono digitou no celular, a IA é pausada na hora.
    if (msg.key?.fromMe) {
      if (!texto && !tipoMidia) return;
      // Em contatos novos o WhatsApp pode entregar um identificador interno (LID).
      // Usamos o telefone real quando o servidor disponibiliza, para pausar a IA
      // exatamente na conversa certa.
      const telefoneAlternativo = somenteDigitos(String(msg.key?.remoteJidAlt || '').split('@')[0]);
      const numeroConversa =
        telefoneAlternativo.length >= 10 ? telefoneAlternativo : somenteDigitos(remoto.split('@')[0]);
      if (numeroConversa.length < 8) return;
      if (foiEnviadoPeloPainel(numeroConversa, texto, msg.key?.id || '')) return;
      estado.mensagensRecebidas += 1;
      await falarComAgente(
        {
          action: 'mensagem_manual',
          instancia: estado.instancia || undefined,
          instance: estado.instancia || undefined,
          numero: numeroConversa,
          phone: numeroConversa,
          jid: remoto,
          nome: msg.pushName || '',
          texto: texto || `[mensagem enviada pelo celular: ${tipoMidia}]`,
          tipo: tipoMidia || 'text',
          mensagem_id: msg.key?.id || undefined,
        },
        20000,
      );
      return;
    }

    // Fotos, videos e audios tambem precisam chegar ao agente: e a foto da tela
    // do aplicativo que libera o teste gratuito automaticamente.
    if (!texto && !tipoMidia) return;
    const textoParaAgente =
      texto || (tipoMidia === 'image' ? '[o cliente enviou uma foto da tela]' : `[o cliente enviou ${tipoMidia}]`);

    // Identificador exato de onde a mensagem chegou: e para ele que a resposta deve voltar.
    const jidResposta = remoto;
    const alternativo = String(msg.key?.senderPn || msg.key?.remoteJidAlt || '').split('@')[0];
    const telefoneReal = somenteDigitos(alternativo);
    const parteRemota = somenteDigitos(remoto.split('@')[0]);
    const numero = telefoneReal.length >= 10 ? telefoneReal : parteRemota;
    const nome = msg.pushName || '';
    estado.mensagensRecebidas += 1;

    const resposta = await falarComAgente({
      action: 'mensagem_recebida',
      instancia: estado.instancia || undefined,
      instance: estado.instancia || undefined,
      numero,
      phone: numero,
      jid: jidResposta,
      nome,
      texto: textoParaAgente,
      tipo: tipoMidia || 'text',
      tem_midia: Boolean(tipoMidia),
      mensagem_id: msg.key?.id || undefined,
    });

    if (resposta?.responda && resposta?.resposta) {
      let enviada = false;
      let erroEnvio = '';
      for (let tentativa = 1; tentativa <= 2 && !enviada; tentativa += 1) {
        try {
          await enviarTexto(jidResposta, resposta.resposta);
          enviada = true;
          estado.respostasEnviadas += 1;
        } catch (erro) {
          erroEnvio = erro?.message || 'erro desconhecido';
          if (tentativa === 1) await aguardar(1200);
        }
      }
      if (!enviada) {
        estado.ultimoErro = `Falha ao enviar resposta automatica: ${erroEnvio}`;
      }
      await informarEnvio(numero, resposta.resposta, enviada, erroEnvio);
    } else if (resposta?.motivo) {
      estado.ultimoErro = `A IA nao respondeu: ${resposta.motivo}${resposta.aviso ? ` - ${resposta.aviso}` : ''}`;
    }
  } catch (erro) {
    estado.ultimoErro = `Falha ao processar mensagem: ${erro?.message || 'erro desconhecido'}`;
  }
}

function aguardar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function limparSessao() {
  estado.geracao += 1;
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  } catch {
    // Se a pasta nao puder ser limpa, a proxima conexao sobrescreve os arquivos.
  }
}

function encerrarSocketAtual() {
  const antigo = estado.sock;
  estado.sock = null;
  estado.sockCriadoEm = null;
  if (!antigo) return;
  try {
    antigo.ev.removeAllListeners('connection.update');
    antigo.ev.removeAllListeners('creds.update');
    antigo.ev.removeAllListeners('messages.upsert');
  } catch {
    // Ignora falhas ao remover os ouvintes.
  }
  try {
    antigo.end?.(undefined);
  } catch {
    // Ignora falhas ao encerrar o socket.
  }
}

function cancelarReconexao() {
  if (estado.timerReconexao) {
    clearTimeout(estado.timerReconexao);
    estado.timerReconexao = null;
  }
}

function agendarReconexao(delayMs) {
  if (estado.paradaManual) return;
  cancelarReconexao();
  estado.timerReconexao = setTimeout(() => {
    estado.timerReconexao = null;
    void iniciarConexao();
  }, delayMs);
}

function tratarAtualizacao(sock, geracao, update) {
  if (geracao !== estado.geracao) return;
  const { connection, lastDisconnect, qr } = update || {};

  if (qr) {
    if (estado.modoCodigo) {
      // Conexao por codigo: o QR nunca vai para o painel. Mesmo assim a janela de
      // vinculo e marcada, para a sessao nao ser apagada enquanto o cliente digita.
      estado.qrEntregueEm = Date.now();
      estado.qr = null;
      estado.qrAtualizadoEm = null;
      estado.conectado = false;
    } else {
      estado.qr = qr;
      // So conta como "novo" quando o texto muda: assim o relogio de validade
      // acompanha a troca real do codigo.
      if (qr !== estado.qrAnterior) {
        estado.qrCriadoEm = Date.now();
        estado.qrAnterior = qr;
      } else if (!estado.qrCriadoEm) {
        estado.qrCriadoEm = Date.now();
      }
      estado.qrAtualizadoEm = new Date().toISOString();
      estado.qrEntregueEm = Date.now();
      estado.conectado = false;
      estado.ultimoErro = null;
    }
  }

  // Depois que o codigo e lido o WhatsApp muda para "connecting" enquanto grava
  // a sessao. Aqui protegemos as credenciais e nao recriamos o socket.
  if (connection === 'connecting') {
    if (estado.qr || estado.qrEntregueEm) {
      estado.pareando = true;
      estado.pareandoEm = estado.pareandoEm || Date.now();
    }
    return;
  }

  if (connection === 'open') {
    estado.conectado = true;
    estado.qr = null;
    estado.qrAnterior = null;
    estado.qrCriadoEm = null;
    estado.ultimoErro = null;
    estado.tentativas = 0;
    estado.qrSolicitadoEm = null;
    estado.iniciandoEm = null;
    estado.pareando = false;
    estado.pareandoEm = null;
    estado.qrEntregueEm = null;
    estado.modoCodigo = false;
    estado.codigoPar = null;
    estado.codigoParEm = null;
    estado.codigoParNumero = null;
    pedidoCodigo = null;
    const bruto = sock.user?.id || '';
    estado.numero = somenteDigitos(String(bruto).split(':')[0].split('@')[0]) || null;
    estado.nome = sock.user?.name || null;
    return;
  }

  if (connection !== 'close') return;

  estado.conectado = false;
  // O WhatsApp as vezes entrega o QR Code junto com o aviso de "conexao fechada".
  // Apagar o codigo aqui fazia o QR nunca chegar ao painel.
  if (!qr) {
    estado.qr = null;
    estado.qrAtualizadoEm = null;
  }
  estado.pareando = false;
  estado.pareandoEm = null;
  estado.qrEntregueEm = null;
  // Codigo de conexao so vale para uma sessao nova: ao cair, ele deixa de servir.
  estado.modoCodigo = false;
  estado.codigoPar = null;
  estado.codigoParEm = null;
  estado.codigoParNumero = null;
  pedidoCodigo = null;
  estado.numero = null;
  estado.nome = null;

  const codigo = lastDisconnect?.error?.output?.statusCode;
  const motivo = String(lastDisconnect?.error?.message || '');
  const encerradaNoCelular =
    codigo === DisconnectReason.loggedOut ||
    codigo === 401 ||
    codigo === 403 ||
    codigo === 405 ||
    /logged out|loggedout|invalid.*session|session.*invalid/i.test(motivo);

  setTimeout(() => {
    if (geracao === estado.geracao) encerrarSocketAtual();
  }, 0);

  if (estado.paradaManual) return;

  if (encerradaNoCelular) {
    limparSessao();
    estado.tentativas = 0;
    estado.ultimoErro =
      'A sessao foi encerrada no celular. Apagando os dados antigos e gerando um QR Code novo automaticamente...';
    agendarReconexao(1200);
    return;
  }

  estado.tentativas += 1;
  estado.ultimoErro = motivo || 'A conexao caiu. Tentando reconectar automaticamente.';

  if (estado.tentativas >= MAX_TENTATIVAS) {
    estado.tentativas = 0;
    limparSessao();
    estado.ultimoErro =
      'A sessao anterior nao pode ser reaproveitada. Ela foi apagada e um QR Code novo sera gerado automaticamente.';
    agendarReconexao(2000);
    return;
  }

  agendarReconexao(Math.min(2500 * estado.tentativas, 15000));
}

// A versao do WhatsApp e consultada UMA vez e fica guardada. Antes, cada tentativa
// de conexao esperava ate 8 segundos por essa consulta antes de criar a sessao:
// era exatamente esse o atraso para o QR Code aparecer.
let versaoCache = null;
let buscandoVersao = null;

function buscarVersao() {
  if (versaoCache) return Promise.resolve(versaoCache);
  if (buscandoVersao) return buscandoVersao;
  buscandoVersao = (async () => {
    try {
      const info = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
      ]);
      if (info?.version) versaoCache = info.version;
      return versaoCache;
    } catch {
      return null;
    } finally {
      buscandoVersao = null;
    }
  })();
  return buscandoVersao;
}

// Nunca segura a criacao da sessao: usa a versao ja guardada ou, no maximo,
// espera 2 segundos. O QR Code sai primeiro, a versao chega depois.
function versaoRapida() {
  if (versaoCache) return Promise.resolve(versaoCache);
  return Promise.race([
    buscarVersao(),
    new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
  ]);
}

async function executarInicio() {
  if (estado.conectado) return;
  if (estado.sock && estado.qr) return;
  if (estado.iniciando) return;

  estado.iniciando = true;
  estado.iniciandoEm = Date.now();
  estado.paradaManual = false;
  cancelarReconexao();

  try {
    encerrarSocketAtual();
    estado.qr = null;
    estado.qrAtualizadoEm = null;
    estado.geracao += 1;
    const geracao = estado.geracao;

    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const versao = await versaoRapida();

    const pedido = pedidoCodigo;
    pedidoCodigo = null;
    // Pedido de codigo SEMPRE abre uma sessao nova. Antes exigiamos que nao
    // houvesse credencial registrada; com uma credencial antiga na pasta o
    // WhatsApp ignorava o pedido e o codigo nunca saia para o painel.
    const modoCodigo = Boolean(pedido?.numero);
    estado.modoCodigo = modoCodigo;
    estado.codigoPar = null;
    estado.codigoParEm = null;
    estado.codigoParNumero = null;

    const sock = makeWASocket({
      version: versao,
      auth: authState,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      // O modo codigo exige um identificador de navegador reconhecido pelo
      // WhatsApp; nomes personalizados fazem o vinculo falhar em silencio.
      browser: modoCodigo ? Browsers.ubuntu('Chrome') : ['NexPlay Painel', 'Chrome', '1.0.0'],
      getMessage: async () => undefined,
    });

    estado.sock = sock;
    estado.sockCriadoEm = Date.now();
    estado.modoCodigo = modoCodigo;

    if (modoCodigo) {
      estado.qr = null;
      estado.qrAtualizadoEm = null;
      estado.qrAnterior = null;
      estado.qrCriadoEm = null;
      setTimeout(async () => {
        if (geracao !== estado.geracao) return;
        const atual = estado.sock;
        if (!atual || !modoCodigo) return;
        try {
          const codigo = await atual.requestPairingCode(pedido.numero);
          estado.codigoPar = String(codigo || '').trim() || null;
          estado.codigoParEm = new Date().toISOString();
          estado.codigoParNumero = pedido.numero;
          estado.pareando = true;
          estado.pareandoEm = estado.pareandoEm || Date.now();
          estado.ultimoErro = null;
        } catch (erro) {
          estado.modoCodigo = false;
          estado.codigoPar = null;
          estado.ultimoErro = `Nao foi possivel gerar o codigo de conexao: ${
            erro?.message || 'erro desconhecido'
          }`;
        }
      }, 3000);
    }

    sock.ev.on('creds.update', async () => {
      if (geracao !== estado.geracao) return;
      try {
        await saveCreds();
      } catch {
        // Uma falha ao gravar credenciais nao deve derrubar o servidor.
      }
    });

    sock.ev.on('connection.update', (update) => {
      try {
        tratarAtualizacao(sock, geracao, update);
      } catch (erro) {
        estado.ultimoErro = erro?.message || 'Falha ao tratar o estado da conexao.';
      }
    });

    sock.ev.on('messages.upsert', async (evento) => {
      if (geracao !== estado.geracao) return;
      if (evento?.type && evento.type !== 'notify') return;
      // Cada mensagem é processada em paralelo. Antes, uma esperava a outra
      // terminar: a segunda mensagem do cliente só era registrada no painel
      // depois que a IA respondesse a primeira, e várias mensagens seguidas
      // apareciam com atraso de minutos.
      for (const msg of evento?.messages || []) {
        void processarMensagemRecebida(msg);
      }
    });
  } catch (erro) {
    estado.ultimoErro = erro?.message || 'Nao foi possivel iniciar a conexao.';
    estado.sock = null;
    estado.tentativas += 1;
    // Credenciais corrompidas impedem qualquer conexao nova: apagamos e recomecamos limpo.
    if (estado.tentativas >= 1) {
      limparSessaoSeSeguro();
    }
    if (estado.tentativas >= MAX_TENTATIVAS) {
      estado.tentativas = 0;
    }
    agendarReconexao(Math.min(3000 * Math.max(estado.tentativas, 1), 15000));
  } finally {
    estado.iniciando = false;
    estado.iniciandoEm = null;
  }
}

function iniciarConexao() {
  if (promessaInicio) return promessaInicio;
  promessaInicio = executarInicio().finally(() => {
    promessaInicio = null;
  });
  return promessaInicio;
}

// Garante que existe uma sessao sendo criada, sem derrubar uma sessao saudavel
// que esta apenas esperando o QR Code aparecer. Reiniciar a sessao sem motivo
// era o que fazia o codigo demorar a chegar ao painel.
function garantirSessao() {
  if (estado.conectado || estado.qr) return;
  // Leitura em curso: recriar o socket agora cortaria o vinculo.
  if (vinculoEmAndamento()) return;
  const agora = Date.now();
  const travadaInicio = estado.iniciandoEm ? agora - estado.iniciandoEm > 20000 : false;
  // Socket criado mas que nunca entregou o QR Code nem conectou tambem conta
  // como travado: antes ele ficava parado para sempre esperando um codigo
  // que nunca vinha, e o painel so via "desconectado".
  const travadaSock = estado.sockCriadoEm ? agora - estado.sockCriadoEm > 25000 : false;
  const travada = travadaInicio || travadaSock;
  if (estado.iniciando && !travada) return;
  if (estado.sock && !travada) return;
  if (estado.sock || estado.iniciando) {
    encerrarSocketAtual();
    estado.iniciando = false;
    estado.iniciandoEm = null;
    promessaInicio = null;
  }
  void iniciarConexao();
}

async function aguardarQr(limiteMs = 20000) {
  const inicio = Date.now();
  while (Date.now() - inicio < limiteMs) {
    if (estado.qr || estado.conectado) break;
    await aguardar(400);
  }
}

function pastaPersistenteOk() {
  try {
    const teste = path.join(AUTH_DIR, `.teste-${Date.now()}`);
    fs.writeFileSync(teste, 'ok');
    fs.unlinkSync(teste);
    return true;
  } catch {
    return false;
  }
}

async function desconectarTudo() {
  estado.paradaManual = true;
  cancelarReconexao();
  limparSessao();

  const sock = estado.sock;
  if (sock) {
    try {
      await Promise.race([sock.logout(), aguardar(6000)]);
    } catch {
      // A sessao pode ja estar invalida; seguimos com a limpeza.
    }
  }

  encerrarSocketAtual();
  estado.conectado = false;
  estado.qr = null;
  estado.qrAtualizadoEm = null;
  estado.numero = null;
  estado.nome = null;
  estado.ultimoErro = null;
  estado.iniciando = false;
  estado.iniciandoEm = null;
  estado.modoCodigo = false;
  estado.codigoPar = null;
  estado.codigoParEm = null;
  estado.codigoParNumero = null;
  pedidoCodigo = null;
  estado.tentativas = 0;
  estado.qrSolicitadoEm = null;
}

const guardiao = {
  executando: false,
  timer: null,
  execucoes: 0,
  cortadosUltima: 0,
  cortadosTotal: 0,
  ultimaExecucao: null,
  proximaExecucao: null,
  ultimoErro: null,
  ultimoAviso: null,
};

function statusGuardiao() {
  return {
    ligado: true,
    intervalo_minutos: GUARDIAO_MINUTOS,
    endereco: GUARDIAO_URL,
    execucoes: guardiao.execucoes,
    ultima_execucao: guardiao.ultimaExecucao,
    proxima_execucao: guardiao.proximaExecucao,
    cortados_ultima: guardiao.cortadosUltima,
    cortados_total: guardiao.cortadosTotal,
    executando: guardiao.executando,
    ultimo_erro: guardiao.ultimoErro,
    ultimo_aviso: guardiao.ultimoAviso,
  };
}

async function rodarGuardiao(origem = 'relogio') {
  if (guardiao.executando) return { ok: true, pulado: true, message: 'A verificacao anterior ainda esta rodando.' };
  guardiao.executando = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (GUARDIAO_KEY) {
      headers.apikey = GUARDIAO_KEY;
      headers.Authorization = `Bearer ${GUARDIAO_KEY}`;
    }
    const resposta = await fetch(GUARDIAO_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: `servidor:${origem}` }),
      signal: controller.signal,
    });
    const texto = await resposta.text();
    let dados = null;
    try {
      dados = texto ? JSON.parse(texto) : null;
    } catch {
      dados = null;
    }

    guardiao.execucoes += 1;
    guardiao.ultimaExecucao = new Date().toISOString();

    if (!resposta.ok) {
      guardiao.ultimoErro = `O painel respondeu ${resposta.status} ao pedir o corte dos testes.`;
      return { ok: false, message: guardiao.ultimoErro };
    }

    const cortados = Number(dados?.cut ?? 0) || 0;
    guardiao.cortadosUltima = cortados;
    guardiao.cortadosTotal += cortados;

    const falhou = dados?.ok === false;
    const aviso = dados?.failed ? `${Number(dados.failed)} acesso(s) nao puderam ser cortados agora.` : null;
    guardiao.ultimoAviso = aviso;
    guardiao.ultimoErro = falhou ? String(dados?.message || 'A rotina respondeu com aviso.') : null;

    if (cortados > 0) {
      console.log(`[nexplay] Relogio dos testes: ${cortados} acesso(s) de teste cortado(s) no painel.`);
    }
    return { ok: !falhou, cut: cortados, message: falhou ? guardiao.ultimoErro : 'Verificacao concluida.' };
  } catch (erro) {
    guardiao.execucoes += 1;
    guardiao.ultimaExecucao = new Date().toISOString();
    guardiao.ultimoErro =
      erro?.name === 'AbortError'
        ? 'A verificacao dos testes demorou demais e foi interrompida.'
        : `Nao foi possivel chamar a rotina de corte: ${erro?.message || 'erro desconhecido'}`;
    return { ok: false, message: guardiao.ultimoErro };
  } finally {
    clearTimeout(timer);
    guardiao.executando = false;
  }
}

function agendarProximoGuardiao() {
  if (guardiao.timer) clearTimeout(guardiao.timer);
  const espera = GUARDIAO_MINUTOS * 60 * 1000;
  guardiao.proximaExecucao = new Date(Date.now() + espera).toISOString();
  guardiao.timer = setTimeout(async () => {
    guardiao.timer = null;
    await rodarGuardiao('relogio');
    agendarProximoGuardiao();
  }, espera);
}

function iniciarRelogioGuardiao() {
  const primeira = 20000;
  guardiao.proximaExecucao = new Date(Date.now() + primeira).toISOString();
  guardiao.timer = setTimeout(async () => {
    guardiao.timer = null;
    await rodarGuardiao('inicio');
    agendarProximoGuardiao();
  }, primeira);
}

// ===================== VIGIA DA CONEXAO =====================
// As vezes o WhatsApp fica "meio aberto": o servidor acredita que esta conectado,
// mas a conexao morreu e nenhuma mensagem chega nem sai. Nesse estado o robo
// simplesmente para de responder sem nenhum aviso. O vigia percebe e reconecta.
const vigia = { timer: null, falhas: 0 };

function verificarSaudeConexao() {
  try {
    if (!estado.conectado) {
      vigia.falhas = 0;
      return;
    }
    const ws = estado.sock?.ws;
    let vivo = true;
    if (ws && typeof ws.isClosed === 'boolean') {
      vivo = !ws.isClosed && ws.isClosing !== true;
    } else if (typeof ws?.readyState === 'number') {
      vivo = ws.readyState === 1;
    }
    if (vivo) {
      vigia.falhas = 0;
      return;
    }
    vigia.falhas += 1;
    if (vigia.falhas < 2) return;
    vigia.falhas = 0;
    estado.ultimoErro = 'A conexao do WhatsApp parou de responder. Reconectando automaticamente...';
    estado.conectado = false;
    encerrarSocketAtual();
    agendarReconexao(1000);
  } catch {
    // Uma falha na verificacao nunca derruba o servidor.
  }
}

function iniciarVigia() {
  if (vigia.timer) clearInterval(vigia.timer);
  vigia.timer = setInterval(verificarSaudeConexao, 2 * 60 * 1000);
}

// ===================== VIGIA DO QR CODE =====================
// Se o painel ja pediu um QR Code e ele nao apareceu, o servidor insiste sozinho.
// Assim o codigo aparece mesmo quando a primeira tentativa de sessao falha em
// silencio (WhatsApp lento, sessao antiga invalida, conexao travada).
const vigiaQr = { timer: null };

function vigiarQr() {
  try {
    const agora = Date.now();

    // Sessao travada no inicio (nunca terminou de criar o socket).
    if (estado.iniciando && estado.iniciandoEm && agora - estado.iniciandoEm > 30000) {
      estado.iniciando = false;
      estado.iniciandoEm = null;
      promessaInicio = null;
      encerrarSocketAtual();
      estado.tentativas = 0;
      estado.ultimoErro = 'A sessao demorou para iniciar. Reiniciando para gerar o QR Code...';
      limparSessaoSeSeguro();
      estado.qrSolicitadoEm = agora;
      agendarReconexao(800);
      return;
    }

    // Conexao por codigo em andamento: nada de recriar a sessao. Reiniciar aqui
    // descartava o pedido de codigo e o cliente ficava sem o codigo na tela.
    if (estado.modoCodigo || estado.codigoPar) return;

    if (!estado.qrSolicitadoEm) return;
    if (estado.conectado || estado.qr || estado.iniciando) return;
    // 25 segundos de paciencia: reiniciar cedo demais matava a sessao que estava
    // apenas comecando, e o QR Code nunca aparecia.
    if (agora - estado.qrSolicitadoEm < 25000) return;

    // Ja pedimos e nada apareceu: recomeca o socket, mas SEM apagar as
    // credenciais — assim um numero ja conectado nao precisa ler o QR de novo.
    estado.qrSolicitadoEm = agora;
    estado.tentativas = 0;
    promessaInicio = null;
    encerrarSocketAtual();
    void iniciarConexao();
  } catch {
    // Uma falha na verificacao nunca derruba o servidor.
  }
}

function iniciarVigiaQr() {
  if (vigiaQr.timer) clearInterval(vigiaQr.timer);
  vigiaQr.timer = setInterval(vigiarQr, 5000);
}

// Mantem o servidor acordado no Render: instancia dormindo = WhatsApp desconectado.
function iniciarPingExterno() {
  const base = String(process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) return;
  const bater = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      await fetch(`${base}/api/health`, { signal: controller.signal });
    } catch {
      // Sem internet agora: a proxima tentativa resolve.
    } finally {
      clearTimeout(timer);
    }
  };
  setInterval(() => {
    void bater();
  }, 4 * 60 * 1000);
  void bater();
}

app.get('/', (req, res) => {
  const rotulo =
    statusConexao() === 'connected'
      ? 'conectado'
      : statusConexao() === 'qr'
        ? 'aguardando leitura do QR Code'
        : statusConexao() === 'connecting'
          ? 'iniciando conexao'
          : 'desconectado';
  res.type('html').send(
    `<html><head><meta charset="utf-8"><title>NexPlay WhatsApp</title></head>
     <body style="font-family:sans-serif;padding:32px;line-height:1.6">
     <h1>Servidor do WhatsApp no ar</h1>
     <p>Status: <strong>${rotulo}</strong></p>
     <p>Diagnostico completo: <a href="/api/diagnostico">/api/diagnostico</a></p>
     </body></html>`,
  );
});

app.get('/api/diagnostico', (req, res) => {
  lerInstanciaDaConsulta(req);
  const problemas = [];
  if (!estado.conectado) problemas.push('O WhatsApp ainda nao esta conectado.');
  if (!pastaPersistenteOk()) problemas.push('A pasta da sessao nao aceita escrita. Confira o disco em /var/data.');
  if (estado.ultimoErro) problemas.push(estado.ultimoErro);
  if (guardiao.ultimoErro) problemas.push(`Relogio dos testes: ${guardiao.ultimoErro}`);

  res.json({
    ok: true,
    servico: 'NexPlay WhatsApp Server',
    versao: VERSAO,
    ...statusResumido(),
    pasta_sessao: AUTH_DIR,
    pasta_persistente: pastaPersistenteOk(),
    permissoes_banco: 'completa',
    relogio_testes: statusGuardiao(),
    agente: AGENTE_URL,
    token_agente: AGENTE_TOKEN ? 'configurado' : 'nao configurado (opcional)',
    iniciado_em: estado.iniciadoEm,
    problemas,
    mensagem:
      problemas.length === 0
        ? 'Tudo pronto: servidor, sessao persistente e comunicacao com o painel funcionando.'
        : 'O servidor esta no ar, mas ainda falta resolver os itens da lista "problemas".',
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, conectado: estado.conectado, status: statusConexao() });
});

app.get('/api/status', (req, res) => {
  lerInstanciaDaConsulta(req);
  res.json({ ...statusResumido(), relogio_testes: statusGuardiao() });
});

app.get('/api/guardiao', (req, res) => {
  res.json({ ok: true, relogio_testes: statusGuardiao() });
});

app.post('/api/guardiao', async (req, res) => {
  const resultado = await rodarGuardiao('manual');
  res.json({ ok: resultado.ok, mensagem: resultado.message, relogio_testes: statusGuardiao() });
});

app.get('/api/qr', (req, res) => {
  lerInstanciaDaConsulta(req);
  res.json({ ...statusResumido(), qr: estado.conectado ? null : estado.qr });
});

app.post('/api/conectar', async (req, res) => {
  const corpo = req.body || {};
  const instancia = String(corpo.instancia || corpo.instance || corpo.instanceName || '').trim();
  if (instancia) estado.instancia = instancia;

  if (estado.conectado) {
    return res.json({ ...statusResumido(), mensagem: 'O WhatsApp ja esta conectado.' });
  }

  // Pedido de codigo em andamento: NAO iniciar sessao de QR Code agora. Antes,
  // a verificacao de status caia aqui e trocava o modo codigo pelo modo QR,
  // e o codigo desaparecia antes de chegar ao painel.
  if (estado.modoCodigo || estado.codigoPar) {
    return res.json({
      ...statusResumido(),
      mensagem: estado.codigoPar
        ? 'Codigo de conexao pronto. Digite no celular em Dispositivos conectados.'
        : 'O codigo de conexao esta sendo gerado. Aguarde alguns segundos.',
    });
  }

  if (!estado.qr) {
    // Apagamos a sessao apenas quando ela nao serve para nada E ninguem esta
    // lendo um codigo agora. Antes, cada clique em "Gerar QR Code" limpava a
    // pasta; se isso acontecesse durante a leitura, o vinculo morria no meio.
    if (!credenciaisValidas() && !vinculoEmAndamento()) {
      limparSessao();
    }
    // Marca que o painel quer um QR Code: o vigia passa a insistir sozinho ate
    // o codigo sair, mesmo que o WhatsApp demore a responder.
    estado.qrSolicitadoEm = Date.now();
    garantirSessao();
    // Espera curta: o codigo costuma sair em 1 a 3 segundos. Se demorar, o painel
    // recebe "conectando" e continua consultando — nada fica preso aqui.
    await aguardarQr(7000);
  }

  const status = statusConexao();
  return res.json({
    ...statusResumido(),
    mensagem:
      status === 'qr'
        ? 'QR Code gerado. Leia no seu WhatsApp em Dispositivos conectados.'
        : status === 'connected'
          ? 'WhatsApp conectado.'
          : status === 'connecting'
            ? 'O servidor esta iniciando a sessao. O QR Code aparece em alguns segundos.'
            : 'Nao foi possivel gerar o QR Code agora. Abra /api/diagnostico para ver o motivo.',
  });
});

app.get('/api/codigo', (req, res) => {
  lerInstanciaDaConsulta(req);
  res.json({ ...statusResumido(), codigo: estado.conectado ? null : estado.codigoPar });
});

// Conexao por codigo de 8 digitos: sem camera, sem QR Code.
// O cliente abre WhatsApp > Dispositivos conectados > Conectar um dispositivo >
// "Conectar com numero de telefone" e digita o codigo que aparece aqui.
app.post('/api/codigo', async (req, res) => {
  const corpo = req.body || {};
  const instancia = String(corpo.instancia || corpo.instance || corpo.instanceName || '').trim();
  if (instancia) estado.instancia = instancia;

  const numero = normalizarNumero(corpo.numero || corpo.phone || corpo.telefone || corpo.to || '');
  if (numero.length < 10 || numero.length > 15) {
    return res.status(400).json({
      ...statusResumido(),
      codigo: null,
      mensagem: 'Informe o numero com codigo do pais e DDD. Ex.: 5511999998888.',
    });
  }

  if (estado.conectado) {
    return res.json({ ...statusResumido(), codigo: null, mensagem: 'O WhatsApp ja esta conectado.' });
  }

  // Cada codigo pertence a uma sessao nova: recomeca do zero para nao misturar
  // com uma tentativa anterior que tenha falhado.
  estado.paradaManual = false;
  estado.iniciando = false;
  estado.iniciandoEm = null;
  estado.tentativas = 0;
  estado.ultimoErro = null;
  // Nesta modalidade nao existe QR Code: qualquer codigo de imagem antigo sai
  // da tela para o painel mostrar o codigo de 8 digitos.
  estado.qr = null;
  estado.qrAtualizadoEm = null;
  estado.qrAnterior = null;
  estado.qrCriadoEm = null;
  estado.qrEntregueEm = null;
  estado.qrSolicitadoEm = null;
  estado.codigoPar = null;
  estado.codigoParEm = null;
  estado.codigoParNumero = null;
  promessaInicio = null;
  encerrarSocketAtual();
  // O pedido de codigo comeca de uma sessao limpa: credencial antiga registrada
  // fazia o WhatsApp recusar o codigo em silencio.
  limparSessao();

  pedidoCodigo = { numero, em: Date.now() };
  void iniciarConexao();

  // O WhatsApp devolve o codigo em poucos segundos. Esperamos um pouco para
  // entregar o codigo pronto ao painel, sem prender a tela por muito tempo.
  const limite = Date.now() + 20000;
  while (Date.now() < limite) {
    if (estado.codigoPar || estado.conectado) break;
    await aguardar(400);
  }

  if (estado.codigoPar) {
    return res.json({
      ...statusResumido(),
      codigo: estado.codigoPar,
      mensagem:
        'Codigo gerado. No celular: WhatsApp > Dispositivos conectados > Conectar um dispositivo > Conectar com numero de telefone.',
    });
  }

  if (estado.conectado) {
    return res.json({ ...statusResumido(), codigo: null, mensagem: 'WhatsApp conectado.' });
  }

  return res.status(409).json({
    ...statusResumido(),
    codigo: null,
    mensagem: estado.ultimoErro || 'Nao foi possivel gerar o codigo agora. Tente novamente em alguns segundos.',
  });
});

app.post('/api/reiniciar', async (req, res) => {
  const corpo = req.body || {};
  const instancia = String(corpo.instancia || corpo.instance || corpo.instanceName || '').trim();
  if (instancia) estado.instancia = instancia;

  await desconectarTudo();
  estado.paradaManual = false;
  estado.qrSolicitadoEm = Date.now();
  void iniciarConexao();
  await aguardarQr(7000);

  const status = statusConexao();
  return res.json({
    ...statusResumido(),
    mensagem:
      status === 'qr'
        ? 'Sessao antiga apagada e QR Code novo gerado.'
        : status === 'connecting'
          ? 'Sessao antiga apagada. O servidor esta gerando um QR Code novo.'
          : 'Sessao antiga apagada, mas o QR Code nao saiu agora. Tente novamente em alguns segundos.',
  });
});

app.post('/api/desconectar', async (req, res) => {
  await desconectarTudo();
  res.json({ ...statusResumido(), mensagem: 'WhatsApp desconectado. A sessao foi apagada.' });
});

app.post('/api/enviar', async (req, res) => {
  const corpo = req.body || {};
  const numero = somenteDigitos(corpo.numero || corpo.phone || corpo.telefone || corpo.to || corpo.jid || '');
  const destino = String(corpo.jid || corpo.numero || corpo.phone || corpo.telefone || corpo.to || '').trim();
  const texto = String(corpo.mensagem || corpo.message || corpo.text || corpo.body || '').trim();

  if (!numero || !destino || !texto) {
    return res.status(400).json({ ok: false, message: 'Informe o numero e a mensagem.' });
  }
  if (!estado.conectado) {
    return res.status(409).json({ ok: false, message: 'O WhatsApp nao esta conectado.' });
  }

  try {
    const envio = await enviarTexto(destino, texto);
    return res.json({ ok: true, jid: envio.jid, mensagem: 'Mensagem enviada.' });
  } catch (erro) {
    return res.status(500).json({ ok: false, message: erro?.message || 'Falha ao enviar a mensagem.' });
  }
});

app.post('/api/agente', async (req, res) => {
  const resposta = await falarComAgente(req.body || {});
  res.json(resposta ?? { ok: false, message: 'Sem resposta do agente.' });
});

process.on('unhandledRejection', (erro) => {
  estado.ultimoErro = `Falha interna tratada: ${erro?.message || 'erro desconhecido'}`;
  console.error('[nexplay] unhandledRejection:', erro?.message || erro);
});

process.on('uncaughtException', (erro) => {
  estado.ultimoErro = `Falha interna tratada: ${erro?.message || 'erro desconhecido'}`;
  console.error('[nexplay] uncaughtException:', erro?.message || erro);
});

app.listen(PORT, '0.0.0.0', () => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  // Deixa a versao do WhatsApp pronta antes de qualquer pedido de QR Code.
  void buscarVersao();
  console.log(`[nexplay] Servidor do WhatsApp ouvindo na porta ${PORT}`);
  console.log(`[nexplay] Pasta da sessao: ${AUTH_DIR}`);
  console.log(`[nexplay] Agente do painel: ${AGENTE_URL}`);
  console.log(`[nexplay] Relogio dos testes: a cada ${GUARDIAO_MINUTOS} minuto(s) em ${GUARDIAO_URL}`);
  iniciarRelogioGuardiao();
  iniciarVigia();
  iniciarVigiaQr();
  iniciarPingExterno();

  if (credenciaisValidas()) {
    console.log('[nexplay] Sessao anterior valida encontrada. Reconectando automaticamente...');
    void iniciarConexao();
  } else {
    limparSessao();
    console.log('[nexplay] Nenhuma sessao valida anterior. Aguardando o painel pedir o QR Code.');
  }
});