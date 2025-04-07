const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const vosk = require('vosk');
const axios = require('axios');
const puppeteer = require('puppeteer');
const SerpApi = require('google-search-results-nodejs');
require('dotenv').config();

// Configurações
const MODEL_PATH = path.join(__dirname, 'model');
const SAMPLE_RATE = 16000;
const serpapi = new SerpApi.GoogleSearch(process.env.SERPAPI_KEY);

const userStates = {};

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'bot',
    dataPath: path.join(__dirname, 'wwebjs_auth')
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  },
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  }
});

// Verifica modelo Vosk
if (!fs.existsSync(MODEL_PATH)) {
  console.error('Modelo Vosk não encontrado. Baixe em: https://alphacephei.com/vosk/models');
  process.exit(1);
}

vosk.setLogLevel(-1);
const model = new vosk.Model(MODEL_PATH);

async function transcreverAudio(audioPath) {
  return new Promise((resolve, reject) => {
    const wavPath = audioPath + '.wav';

    ffmpeg(audioPath)
      .audioChannels(1)
      .audioFrequency(SAMPLE_RATE)
      .format('wav')
      .on('end', () => {
        const recognizer = new vosk.Recognizer({ model, sampleRate: SAMPLE_RATE });
        const stream = fs.createReadStream(wavPath);
        let transcript = '';

        stream.on('data', data => {
          if (recognizer.acceptWaveform(data)) {
            transcript += recognizer.result().text + ' ';
          }
        });

        stream.on('end', () => {
          transcript += recognizer.finalResult().text;
          recognizer.free();
          fs.unlinkSync(audioPath);
          fs.unlinkSync(wavPath);
          resolve(transcript.trim());
        });
      })
      .on('error', reject)
      .save(wavPath);
  });
}

async function obterCoordenadasNominatim(endereco) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(endereco)}`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': 'BotAjudaIdoso/1.0' }
  });
  if (resp.data.length === 0) throw new Error('Endereço não encontrado');
  const { lat, lon } = resp.data[0];
  return { lat, lon };
}

async function buscarFarmaciasOverpass(lat, lon) {
  const overpassUrl = 'https://overpass-api.de/api/interpreter';
  const query = `
    [out:json];
    node["amenity"="pharmacy"](around:2000, ${lat}, ${lon});
    out;
  `;
  const resp = await axios.post(overpassUrl, `data=${encodeURIComponent(query)}`);
  const farmaciasBrutas = resp.data.elements;

  const farmaciasFiltradas = farmaciasBrutas
    .map(e => {
      const tags = e.tags || {};
      const partes = [
        tags['addr:full'],
        tags['addr:street'],
        tags['addr:housenumber'],
        tags['addr:suburb'],
        tags['addr:city'],
        tags['addr:postcode']
      ].filter(Boolean);

      const endereco = partes.length > 0 ? partes.join(', ') : null;

      return {
        nome: tags.name || null,
        endereco,
        telefone: tags['contact:phone'] || tags['phone'] || null
      };
    })
    .filter(f => f.nome && f.endereco);

  return farmaciasFiltradas;
}

async function buscarStatusFarmaciaSerpAPI(nome, endereco) {
  try {
    const params = {
      engine: "google_maps",
      q: `${nome} ${endereco}`,
      type: "search",
      api_key: process.env.SERPAPI_KEY
    };

    return new Promise((resolve, reject) => {
      serpapi.json(params, (data) => {
        if (data.error) {
          console.error('Erro na SerpAPI:', data.error);
          return resolve({
            telefone: null,
            status: 'Status não disponível'
          });
        }

        if (data.local_results && data.local_results.length > 0) {
          const resultado = data.local_results[0];
          const info = {
            telefone: resultado.phone || null,
            status: resultado.open_now ? 'Aberta agora' : 'Fechada no momento'
          };
          return resolve(info);
        }

        if (data.place_results) {
          const info = {
            telefone: data.place_results.phone || null,
            status: data.place_results.opening_hours?.open_now ? 'Aberta agora' : 'Fechada no momento'
          };
          return resolve(info);
        }

        resolve({
          telefone: null,
          status: 'Status não disponível'
        });
      });
    });
  } catch (err) {
    console.error('Erro na SerpAPI:', err);
    return {
      telefone: null,
      status: 'Status não disponível'
    };
  }
}

async function buscarStatusFarmaciaGoogleMaps(nome, endereco) {
  const termoBusca = `${nome} ${endereco}`;
  const urlBusca = `https://www.google.com/maps/search/${encodeURIComponent(termoBusca)}`;

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(urlBusca, { waitUntil: 'networkidle2' });

  try {
    const primeiroResultado = await page.$('a.hfpxzc');
    if (primeiroResultado) {
      await primeiroResultado.click();
      await page.waitForTimeout(5000);
    }

    const status = await page.evaluate(() => {
      const elementosStatus = Array.from(document.querySelectorAll('*'));
      for (let el of elementosStatus) {
        const texto = el.innerText?.trim();
        if (texto && (texto.includes('Aberto') || texto.includes('Aberta') || texto.includes('Fechado') || texto.includes('Fechada'))) {
          return texto;
        }
      }
      return 'Status não disponível';
    });

    let telefone = null;
    const regexTelefone = /\(?\d{2}\)?\s?\d{4,5}-\d{4}/;
    const candidatosTelefone = await page.$$('span, div, button, a');
    
    for (let el of candidatosTelefone) {
      const texto = await page.evaluate(e => e.innerText?.trim(), el);
      if (texto && regexTelefone.test(texto)) {
        telefone = texto.match(regexTelefone)[0];
        break;
      }
    }

    await browser.close();
    return { telefone, status };
  } catch (err) {
    await browser.close();
    console.error('Erro ao buscar informações:', err);
    return {
      telefone: null,
      status: 'Status não disponível'
    };
  }
}

async function buscarFarmacias(endereco, nomeRemedio) {
  const { lat, lon } = await obterCoordenadasNominatim(endereco);
  const todasFarmacias = await buscarFarmaciasOverpass(lat, lon);
  const farmaciasValidas = todasFarmacias.filter(f => {
    const nomeValido = f.nome && f.nome.toLowerCase() !== 'farmácia sem nome';
    const enderecoValido = f.endereco && f.endereco.toLowerCase() !== 'endereço não informado';
    return nomeValido && enderecoValido;
  });
  return farmaciasValidas.slice(0, 5);
}

function formatarNumeroWhatsApp(numero) {
  if (!numero) return null;
  
  const apenasNumeros = numero.replace(/\D/g, '');
  
  // Remove zeros e nones iniciais
  let numeroLimpo = apenasNumeros.replace(/^0+/, '').replace(/^55+/, '');
  
  // Garante que tenha DDD (2 dígitos) + número (8 ou 9 dígitos)
  if (numeroLimpo.length === 10) { // 8 dígitos + DDD
    return '55' + numeroLimpo;
  }
  
  if (numeroLimpo.length === 11) { // 9 dígitos + DDD
    return '55' + numeroLimpo;
  }
  
  // Se já estiver no formato internacional (ex: 5511987654321)
  if (apenasNumeros.length >= 12 && apenasNumeros.startsWith('55')) {
    return apenasNumeros;
  }
  
  return null; // Retorna null para números inválidos
}

async function enviarMensagemFarmacia(numeroFarmacia, nomeFarmacia, nomeRemedio, enderecoUsuario) {
  try {
    if (!numeroFarmacia) {
      return { success: false, message: 'Número de telefone inválido' };
    }
    
    const numeroFormatado = formatarNumeroWhatsApp(numeroFarmacia);
    if (!numeroFormatado) {
      return { success: false, message: 'Número de telefone inválido' };
    }
    
    const numeroCompleto = numeroFormatado + '@c.us';
    
    const isRegistered = await client.isRegisteredUser(numeroCompleto);
    
    if (!isRegistered) {
      return { success: false, message: 'Esta farmácia não possui WhatsApp registrado' };
    }
    
    const mensagem = `*Mensagem Automática - Assistente Virtual para Idosos*\n\n` +
                     `Olá, ${nomeFarmacia}!\n\n` +
                     `Estou ajudando um(a) idoso(a) que necessita do seguinte medicamento:\n\n` +
                     `💊 *Medicamento solicitado:* ${nomeRemedio}\n\n` +
                     `📍 *Endereço para entrega:* ${enderecoUsuario}\n\n` +
                     `💵 *Forma de pagamento:* Dinheiro\n\n` +
                     `Por favor, nos informe:\n` +
                     `1. Se possuem este medicamento em estoque\n` +
                     `2. Valor total com entrega (se aplicável)\n` +
                     `3. Tempo estimado para entrega\n\n` +
                     `*Se puderem atender este pedido, por favor responda com "SIM".*\n\n` +
                     `Agradecemos pela atenção!`;
    
    await client.sendMessage(numeroCompleto, mensagem);
    return { success: true, message: 'Pedido enviado com sucesso!' };
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);
    return { 
      success: false, 
      message: 'Erro ao enviar pedido. Por favor, tente novamente mais tarde ou contate a farmácia diretamente.'
    };
  }
}

// Função para processar respostas por áudio
async function processarRespostaAudio(msg, estado) {
  const media = await msg.downloadMedia();
  const audioPath = path.join(__dirname, `audio_${Date.now()}.ogg`);
  fs.writeFileSync(audioPath, Buffer.from(media.data, 'base64'));

  try {
    const transcricao = await transcreverAudio(audioPath);
    if (!transcricao) {
      await msg.reply('❌ Não consegui entender o áudio. Tente novamente.');
      return null;
    }
    
    // Log para depuração
    console.log(`Transcrição do áudio: ${transcricao}`);
    
    return transcricao.toLowerCase().trim();
  } catch (err) {
    console.error('Erro ao processar áudio:', err);
    await msg.reply('⚠️ Ocorreu um erro ao processar seu áudio. Tente novamente ou digite sua resposta.');
    return null;
  }
}

function verificarCancelamento(texto) {
  const palavrasCancelamento = ['cancelar', 'parar', 'sair', 'não', 'nao', 'voltar'];
  return palavrasCancelamento.some(palavra => texto.includes(palavra));
}

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', () => {
  console.log('✅ Bot conectado!');
});

client.on('message', async msg => {
  const userId = msg.from;
  if (!userStates[userId]) userStates[userId] = {};
  const estado = userStates[userId];

  // Função auxiliar para responder
  const responder = async (texto) => {
    await msg.reply(texto);
  };

  // Função para limpar estado do usuário
  const limparEstado = () => {
    userStates[userId] = {};
  };

  // Resposta inicial
  if (msg.body.toLowerCase().includes('oi') || msg.body.toLowerCase().includes('olá') || msg.body.toLowerCase().includes('ola')) {
    return responder('👋 Olá! Que bom falar com você 😊. Eu sou um assistente virtual e posso te ajudar a encontrar farmácias próximas com o remédio que você precisa. Me envie um áudio com o nome do remédio ou escreva aqui o que deseja.\n\nA qualquer momento você pode dizer *"cancelar"* para parar.');
  }

  // Se for um áudio, processamos
  if (msg.hasMedia && msg.type === 'ptt') {
    const transcricao = await processarRespostaAudio(msg, estado);
    if (!transcricao) return;

    // Verifica se o usuário quer cancelar
    if (verificarCancelamento(transcricao)) {
      limparEstado();
      return responder('❌ Operação cancelada. Se precisar de ajuda novamente, é só me chamar!');
    }

    // Se estiver confirmando o nome do remédio
    if (estado.aguardandoConfirmacaoRemedio) {
      if (transcricao.includes('sim') || transcricao.includes('confirm')) {
        estado.ultimoRemedioConfirmado = estado.ultimoRemedio;
        estado.aguardandoConfirmacaoRemedio = false;
        estado.esperandoEndereco = true;
        return responder('✅ Ótimo! Agora, por favor, me envie um áudio com seu endereço completo (com bairro e cidade).');
      } else {
        estado.ultimoRemedio = null;
        estado.aguardandoConfirmacaoRemedio = false;
        return responder('🔁 Por favor, envie novamente o nome do remédio que você precisa.');
      }
    }

    // Se estiver esperando endereço
    if (estado.esperandoEndereco) {
      estado.endereco = transcricao;
      estado.esperandoEndereco = false;
      return responder('📍 Obrigado! Agora me envie um áudio dizendo o nome do remédio que você precisa.');
    }

    // Seleção de farmácia por áudio
    if (estado.escolhendoFarmacia) {
      const escolha = parseInt(transcricao.match(/\d+/)?.[0]);
      const { opcoes, ultimoRemedioConfirmado, endereco } = estado;

      if (!isNaN(escolha) && escolha >= 1 && escolha <= opcoes.length) {
        const farmaciaEscolhida = opcoes[escolha - 1];
        
        // Limpa o estado de escolha antes de prosseguir
        estado.escolhendoFarmacia = false;
        
        let infoFarmacia = await buscarStatusFarmaciaSerpAPI(farmaciaEscolhida.nome, farmaciaEscolhida.endereco);
        
        if (!infoFarmacia.telefone) {
          infoFarmacia = await buscarStatusFarmaciaGoogleMaps(farmaciaEscolhida.nome, farmaciaEscolhida.endereco);
        }

        let resposta = `✉️ *Informações da Farmácia*\n\n`;
        resposta += `🏥 *${farmaciaEscolhida.nome}*\n`;
        resposta += `📍 ${farmaciaEscolhida.endereco}\n`;
        resposta += `📞 ${infoFarmacia.telefone || 'Telefone não encontrado'}\n`;
        resposta += `🟢 ${infoFarmacia.status}\n\n`;
        resposta += `💊 *Remédio solicitado:* ${ultimoRemedioConfirmado}\n\n`;

        if (infoFarmacia.telefone) {
          estado.ultimaFarmacia = {
            nome: farmaciaEscolhida.nome,
            telefone: infoFarmacia.telefone
          };
          
          resposta += `Deseja que eu envie uma mensagem para esta farmácia perguntando sobre o remédio *${ultimoRemedioConfirmado}* e informando seu endereço *${endereco}*?\n\n`;
          resposta += `Responda por áudio dizendo *"SIM"* para confirmar ou *"NÃO"* para cancelar.`;
          
          estado.aguardandoConfirmacao = true;
        } else {
          resposta += `*Mensagem sugerida:*\n"Olá! Gostaria de saber se vocês têm o remédio ${ultimoRemedioConfirmado} e qual o valor. Obrigado!"`;
        }

        await responder(resposta);
      } else {
        // Mantém no estado de escolha se a resposta for inválida
        await responder(`❗ Por favor, envie um áudio dizendo o número entre 1 e ${opcoes.length} correspondente à farmácia desejada ou "cancelar" para parar.`);
      }
      return;
    }

    // Confirmação de envio para farmácia por áudio
    if (estado.aguardandoConfirmacao) {
      const respostaUsuario = transcricao;
      
      if (respostaUsuario.includes('sim') || respostaUsuario.includes('confirm')) {
        const { ultimaFarmacia, ultimoRemedioConfirmado, endereco } = estado;
        
        await responder('⏳ Enviando pedido para a farmácia...');
        
        const resultado = await enviarMensagemFarmacia(
          ultimaFarmacia.telefone,
          ultimaFarmacia.nome,
          ultimoRemedioConfirmado,
          endereco
        );
        
        if (resultado.success) {
          await responder('✅ Pedido enviado! A farmácia foi contatada com estas informações:\n\n' +
                        `🏥 *Farmácia:* ${ultimaFarmacia.nome}\n` +
                        `💊 *Remédio:* ${ultimoRemedioConfirmado}\n` +
                        `📍 *Endereço:* ${endereco}\n` +
                        `💵 *Pagamento:* Dinheiro\n\n` +
                        `Aguarde a resposta deles. Vou te avisar quando responderem!`);
          
          estado.aguardandoResposta = {
            farmacia: ultimaFarmacia.nome,
            numero: ultimaFarmacia.telefone,
            remedio: ultimoRemedioConfirmado
          };
        } else {
          await responder(`❌ ${resultado.message}\n\nVocê pode tentar entrar em contato manualmente pelo número: ${ultimaFarmacia.telefone}`);
        }
      } else if (respostaUsuario.includes('não') || respostaUsuario.includes('nao') || respostaUsuario.includes('não') || respostaUsuario.includes('cancel')) {
        await responder('❌ Pedido cancelado. Você pode entrar em contato manualmente se desejar.');
      } else {
        // Mantém no estado de confirmação se a resposta for inválida
        await responder('❗ Por favor, responda por áudio dizendo *"SIM"* para confirmar o envio ou *"NÃO"* para cancelar.');
        return;
      }
      
      // Limpa os estados independente da resposta
      estado.aguardandoConfirmacao = false;
      estado.ultimaFarmacia = null;
      return;
    }

    // Se não estiver em nenhum estado específico, assume que é o nome do remédio
    if (!estado.endereco) {
      estado.ultimoRemedio = transcricao;
      estado.aguardandoConfirmacaoRemedio = true;
      return responder(`Você disse: *${transcricao}*\n\nEste é o nome correto do remédio que você precisa? Responda por áudio dizendo *"SIM"* para confirmar ou *"NÃO"* para corrigir.`);
    }

    // Busca farmácias com o remédio informado
    await responder(`🔍 Procurando farmácias próximas com o remédio: *${transcricao}*...`);
    const farmacias = await buscarFarmacias(estado.endereco, transcricao);

    if (farmacias.length === 0) return responder('🚫 Não encontrei farmácias por perto. Tente outro endereço.');

    let resposta = '🏥 Farmácias próximas:\n';
    farmacias.forEach((f, i) => {
      resposta += `\n${i + 1}. *${f.nome}*\n📍 ${f.endereco}`;
    });

    resposta += `\n\nDeseja que eu entre em contato com alguma dessas farmácias perguntando pelo remédio "${transcricao}"? Me envie um áudio dizendo o número da farmácia da lista (1 a ${farmacias.length}) ou "cancelar" para parar.`;

    estado.opcoes = farmacias;
    estado.ultimoRemedio = transcricao;
    estado.escolhendoFarmacia = true;

    await responder(resposta);
    return;
  }

  // Processamento de mensagens de texto (mantido para compatibilidade)
  if (!msg.hasMedia) {
    const texto = msg.body.toLowerCase().trim();

    // Verifica se o usuário quer cancelar
    if (verificarCancelamento(texto)) {
      limparEstado();
      return responder('❌ Operação cancelada. Se precisar de ajuda novamente, é só me chamar!');
    }

    // Se estiver confirmando o nome do remédio
    if (estado.aguardandoConfirmacaoRemedio) {
      if (texto === 'sim' || texto === 's' || texto === 'confirmar') {
        estado.ultimoRemedioConfirmado = estado.ultimoRemedio;
        estado.aguardandoConfirmacaoRemedio = false;
        estado.esperandoEndereco = true;
        return responder('✅ Ótimo! Agora, por favor, me diga seu endereço completo (com bairro e cidade).');
      } else {
        estado.ultimoRemedio = null;
        estado.aguardandoConfirmacaoRemedio = false;
        return responder('🔁 Por favor, envie novamente o nome do remédio que você precisa.');
      }
    }

    // Se estiver esperando endereço
    if (estado.esperandoEndereco) {
      estado.endereco = msg.body;
      estado.esperandoEndereco = false;
      return responder('📍 Obrigado! Agora me diga o nome do remédio que você precisa.');
    }

    // Seleção de farmácia
    if (estado.escolhendoFarmacia) {
      const escolha = parseInt(texto);
      const { opcoes, ultimoRemedioConfirmado, endereco } = estado;

      if (!isNaN(escolha) && escolha >= 1 && escolha <= opcoes.length) {
        const farmaciaEscolhida = opcoes[escolha - 1];
        
        // Limpa o estado de escolha antes de prosseguir
        estado.escolhendoFarmacia = false;
        
        let infoFarmacia = await buscarStatusFarmaciaSerpAPI(farmaciaEscolhida.nome, farmaciaEscolhida.endereco);
        
        if (!infoFarmacia.telefone) {
          infoFarmacia = await buscarStatusFarmaciaGoogleMaps(farmaciaEscolhida.nome, farmaciaEscolhida.endereco);
        }

        let resposta = `✉️ *Informações da Farmácia*\n\n`;
        resposta += `🏥 *${farmaciaEscolhida.nome}*\n`;
        resposta += `📍 ${farmaciaEscolhida.endereco}\n`;
        resposta += `📞 ${infoFarmacia.telefone || 'Telefone não encontrado'}\n`;
        resposta += `🟢 ${infoFarmacia.status}\n\n`;
        resposta += `💊 *Remédio solicitado:* ${ultimoRemedioConfirmado}\n\n`;

        if (infoFarmacia.telefone) {
          estado.ultimaFarmacia = {
            nome: farmaciaEscolhida.nome,
            telefone: infoFarmacia.telefone
          };
          
          resposta += `Deseja que eu envie uma mensagem para esta farmácia perguntando sobre o remédio *${ultimoRemedioConfirmado}* e informando seu endereço *${endereco}*?\n\n`;
          resposta += `Digite *"SIM"* para confirmar ou *"NÃO"* para cancelar.`;
          
          estado.aguardandoConfirmacao = true;
        } else {
          resposta += `*Mensagem sugerida:*\n"Olá! Gostaria de saber se vocês têm o remédio ${ultimoRemedioConfirmado} e qual o valor. Obrigado!"`;
        }

        await responder(resposta);
      } else {
        // Mantém no estado de escolha se a resposta for inválida
        await responder(`❗ Por favor, envie um número entre 1 e ${opcoes.length} correspondente à farmácia desejada ou "cancelar" para parar.`);
      }
      return;
    }

    // Confirmação de envio para farmácia
    if (estado.aguardandoConfirmacao) {
      const respostaUsuario = texto;
      
      if (respostaUsuario === 'sim' || respostaUsuario === 's' || respostaUsuario === 'yes') {
        const { ultimaFarmacia, ultimoRemedioConfirmado, endereco } = estado;
        
        await responder('⏳ Enviando pedido para a farmácia...');
        
        const resultado = await enviarMensagemFarmacia(
          ultimaFarmacia.telefone,
          ultimaFarmacia.nome,
          ultimoRemedioConfirmado,
          endereco
        );
        
        if (resultado.success) {
          await responder('✅ Pedido enviado! A farmácia foi contatada com estas informações:\n\n' +
                        `🏥 *Farmácia:* ${ultimaFarmacia.nome}\n` +
                        `💊 *Remédio:* ${ultimoRemedioConfirmado}\n` +
                        `📍 *Endereço:* ${endereco}\n` +
                        `💵 *Pagamento:* Dinheiro\n\n` +
                        `Aguarde a resposta deles. Vou te avisar quando responderem!`);
          
          estado.aguardandoResposta = {
            farmacia: ultimaFarmacia.nome,
            numero: ultimaFarmacia.telefone,
            remedio: ultimoRemedioConfirmado
          };
        } else {
          await responder(`❌ ${resultado.message}\n\nVocê pode tentar entrar em contato manualmente pelo número: ${ultimaFarmacia.telefone}`);
        }
      } else if (respostaUsuario === 'não' || respostaUsuario === 'nao' || respostaUsuario === 'n' || respostaUsuario === 'no') {
        await responder('❌ Pedido cancelado. Você pode entrar em contato manualmente se desejar.');
      } else {
        // Mantém no estado de confirmação se a resposta for inválida
        await responder('❗ Por favor, responda *"SIM"* para confirmar o envio ou *"NÃO"* para cancelar.');
        return;
      }
      
      // Limpa os estados independente da resposta
      estado.aguardandoConfirmacao = false;
      estado.ultimaFarmacia = null;
      return;
    }

    // Se não estiver em nenhum estado específico, assume que é o nome do remédio
    if (!estado.endereco) {
      estado.ultimoRemedio = msg.body;
      estado.aguardandoConfirmacaoRemedio = true;
      return responder(`Você disse: *${msg.body}*\n\nEste é o nome correto do remédio que você precisa? Responda *"SIM"* para confirmar ou *"NÃO"* para corrigir.`);
    }
  }

  // Mensagem genérica se não estiver em nenhum fluxo específico
  responder('ℹ️ Para começar, me envie um áudio com o nome do remédio que você precisa ou digite "ajuda" para ver as opções.\n\nA qualquer momento você pode dizer *"cancelar"* para parar.');
});

client.on('message_create', async (msg) => {
  for (const userId in userStates) {
    const estado = userStates[userId];
    if (estado.aguardandoResposta) {
      const from = msg.from.replace('@c.us', '');
      const numeroFarmacia = formatarNumeroWhatsApp(estado.aguardandoResposta.numero);
      
      if (from === numeroFarmacia) {
        if (msg.body.toLowerCase().includes('sim')) {
          await client.sendMessage(userId, 
            `🎉 Boa notícia! A farmácia *${estado.aguardandoResposta.farmacia}* confirmou que tem o remédio *${estado.aguardandoResposta.remedio}*!\n\n` +
            `Eles devem entrar em contato com você em breve para combinar os detalhes da entrega.`
          );
        } else {
          await client.sendMessage(userId,
            `ℹ️ A farmácia *${estado.aguardandoResposta.farmacia}* respondeu:\n\n` +
            `"${msg.body}"\n\n` +
            `Por favor, verifique se precisa tomar alguma providência.`
          );
        }
        delete estado.aguardandoResposta;
      }
    }
  }
});

client.initialize();