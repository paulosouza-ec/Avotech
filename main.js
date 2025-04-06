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

async function buscarInfoFarmaciaSerpAPI(nome, endereco) {
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
            horario: 'Horário não disponível'
          });
        }

        if (data.local_results && data.local_results.length > 0) {
          const resultado = data.local_results[0];
          const info = {
            telefone: resultado.phone || null,
            horario: resultado.hours || resultado.operating_hours || 'Horário não disponível'
          };
          return resolve(info);
        }

        if (data.place_results) {
          const info = {
            telefone: data.place_results.phone || null,
            horario: data.place_results.hours || data.place_results.operating_hours || 'Horário não disponível'
          };
          return resolve(info);
        }

        if (data.place_results && data.place_results.place_id) {
          buscarDetalhesSerpAPI(data.place_results.place_id)
            .then(resolve)
            .catch(() => resolve({
              telefone: null,
              horario: 'Horário não disponível'
            }));
        } else {
          resolve({
            telefone: null,
            horario: 'Horário não disponível'
          });
        }
      });
    });
  } catch (err) {
    console.error('Erro na SerpAPI:', err);
    return {
      telefone: null,
      horario: 'Horário não disponível'
    };
  }
}

async function buscarDetalhesSerpAPI(placeId) {
  const params = {
    engine: "google_maps",
    data_id: placeId,
    type: "place",
    api_key: process.env.SERPAPI_KEY
  };

  return new Promise((resolve, reject) => {
    serpapi.json(params, (data) => {
      const info = {
        telefone: data.phone || null,
        horario: data.hours || data.operating_hours || 'Horário não disponível'
      };
      resolve(info);
    });
  });
}

async function buscarInfoFarmaciaGoogleMaps(nome, endereco) {
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

    const info = await page.evaluate(() => {
      const regexTelefone = /\(?\d{2}\)?\s?\d{4,5}-\d{4}/;
      let telefone = null;
      
      const candidatosTelefone = Array.from(document.querySelectorAll('span, div, button, a'));
      for (let el of candidatosTelefone) {
        const texto = el.innerText?.trim();
        if (texto && regexTelefone.test(texto)) {
          telefone = texto.match(regexTelefone)[0];
          break;
        }
      }

      let horario = 'Horário não disponível';
      const elementosHorario = Array.from(document.querySelectorAll('*'));
      for (let el of elementosHorario) {
        const texto = el.innerText?.trim();
        if (texto && (texto.includes('Horário') || texto.includes('Abre') || texto.includes('Fecha'))) {
          horario = texto;
          let proximo = el.nextElementSibling;
          if (proximo && proximo.innerText) {
            horario += ': ' + proximo.innerText.trim();
          }
          break;
        }
      }

      return { telefone, horario };
    });

    await browser.close();
    return info;
  } catch (err) {
    await browser.close();
    console.error('Erro ao buscar informações:', err);
    return {
      telefone: null,
      horario: 'Erro ao buscar horário'
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

function formatarHorario(horario) {
  if (!horario) return 'Horário não disponível';
  
  // Se for string, retorna diretamente
  if (typeof horario === 'string') {
    return horario;
  }
  
  // Se for objeto, tenta formatar
  if (typeof horario === 'object' && horario !== null) {
    try {
      // Caso especial para weekday_text do Google
      if (horario.weekday_text) {
        return horario.weekday_text.join('\n');
      }
      
      // Caso geral para objetos de horário
      if (Array.isArray(horario)) {
        return horario.join('\n');
      }
      
      // Para objetos com propriedades de dias
      if (Object.keys(horario).some(k => ['segunda', 'terça', 'quarta', 'domingo'].includes(k.toLowerCase()))) {
        return Object.entries(horario)
          .map(([dia, horas]) => `${dia.charAt(0).toUpperCase() + dia.slice(1)}: ${horas}`)
          .join('\n');
      }
      
      // Se não reconhecer o formato, converte para string
      return JSON.stringify(horario);
    } catch (e) {
      console.error('Erro ao formatar horário:', e);
      return 'Horário disponível (consulte a farmácia)';
    }
  }
  
  return 'Horário não disponível';
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

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', () => {
  console.log('✅ Bot conectado!');
});

client.on('message', async msg => {
  const userId = msg.from;
  if (!userStates[userId]) userStates[userId] = {};
  const estado = userStates[userId];

  // Resposta inicial
  if (msg.body.toLowerCase().includes('oi') || msg.body.toLowerCase().includes('olá') || msg.body.toLowerCase().includes('ola')) {
    return msg.reply('👋 Olá! Que bom falar com você 😊. Eu sou um assistente virtual e posso te ajudar a encontrar farmácias próximas com o remédio que você precisa. Me envie um áudio com o nome do remédio ou escreva aqui o que deseja.');
  }

  // Se estiver esperando endereço
  if (estado.esperandoEndereco) {
    estado.endereco = msg.body;
    estado.esperandoEndereco = false;
    msg.reply('📍 Obrigado! Agora me envie um áudio dizendo o nome do remédio que você precisa.');
    return;
  }

  // Processamento de áudio
  if (msg.hasMedia && msg.type === 'ptt') {
    const media = await msg.downloadMedia();
    const audioPath = path.join(__dirname, `audio_${Date.now()}.ogg`);
    fs.writeFileSync(audioPath, Buffer.from(media.data, 'base64'));

    try {
      const transcricao = await transcreverAudio(audioPath);
      if (!transcricao) return msg.reply('❌ Não consegui entender o áudio. Tente novamente.');

      if (!estado.endereco) {
        estado.ultimoRemedio = transcricao;
        estado.esperandoEndereco = true;
        return msg.reply('📍 Antes de buscar farmácias, por favor me diga seu endereço completo (com bairro e cidade).');
      }

      msg.reply(`🔍 Procurando farmácias próximas com o remédio: *${transcricao}*...`);
      const farmacias = await buscarFarmacias(estado.endereco, transcricao);

      if (farmacias.length === 0) return msg.reply('🚫 Não encontrei farmácias por perto. Tente outro endereço.');

      let resposta = '🏥 Farmácias próximas:\n';
      farmacias.forEach((f, i) => {
        resposta += `\n${i + 1}. *${f.nome}*\n📍 ${f.endereco}`;
      });

      resposta += `\n\nDeseja que eu entre em contato com alguma dessas farmácias perguntando pelo remédio "${transcricao}"? Me diga o número da farmácia da lista (1 a ${farmacias.length}).`;

      estado.opcoes = farmacias;
      estado.ultimoRemedio = transcricao;
      estado.escolhendoFarmacia = true;

      msg.reply(resposta);
    } catch (err) {
      console.error('Erro no áudio:', err);
      msg.reply('⚠️ Ocorreu um erro ao processar o áudio');
    }
    return;
  }

  // Seleção de farmácia
  if (estado.escolhendoFarmacia) {
    const escolha = parseInt(msg.body.trim());
    const { opcoes, ultimoRemedio, endereco } = estado;

    if (!isNaN(escolha) && escolha >= 1 && escolha <= opcoes.length) {
      const farmaciaEscolhida = opcoes[escolha - 1];
      
      // Limpa o estado de escolha antes de prosseguir
      estado.escolhendoFarmacia = false;
      
      let infoFarmacia = await buscarInfoFarmaciaSerpAPI(farmaciaEscolhida.nome, farmaciaEscolhida.endereco);
      
      if (!infoFarmacia.telefone) {
        infoFarmacia = await buscarInfoFarmaciaGoogleMaps(farmaciaEscolhida.nome, farmaciaEscolhida.endereco);
      }

      let resposta = `✉️ *Informações da Farmácia*\n\n`;
      resposta += `🏥 *${farmaciaEscolhida.nome}*\n`;
      resposta += `📍 ${farmaciaEscolhida.endereco}\n`;
      resposta += `📞 ${infoFarmacia.telefone || 'Telefone não encontrado'}\n`;
      resposta += `🕒 ${formatarHorario(infoFarmacia.horario)}\n\n`;
      resposta += `💊 *Remédio solicitado:* ${ultimoRemedio}\n\n`;

      if (infoFarmacia.telefone) {
        estado.ultimaFarmacia = {
          nome: farmaciaEscolhida.nome,
          telefone: infoFarmacia.telefone
        };
        
        resposta += `Deseja que eu envie uma mensagem para esta farmácia perguntando sobre o remédio *${ultimoRemedio}* e informando seu endereço *${endereco}*?\n\n`;
        resposta += `Digite *"SIM"* para confirmar ou *"NÃO"* para cancelar.`;
        
        estado.aguardandoConfirmacao = true;
      } else {
        resposta += `*Mensagem sugerida:*\n"Olá! Gostaria de saber se vocês têm o remédio ${ultimoRemedio} e qual o valor. Obrigado!"`;
      }

      await msg.reply(resposta);
    } else {
      // Mantém no estado de escolha se a resposta for inválida
      await msg.reply(`❗ Por favor, envie um número entre 1 e ${opcoes.length} correspondente à farmácia desejada.`);
    }
    return;
  }

  // Confirmação de envio para farmácia
  if (estado.aguardandoConfirmacao) {
    const respostaUsuario = msg.body.toLowerCase().trim();
    
    if (respostaUsuario === 'sim' || respostaUsuario === 's' || respostaUsuario === 'yes') {
      const { ultimaFarmacia, ultimoRemedio, endereco } = estado;
      
      await msg.reply('⏳ Enviando pedido para a farmácia...');
      
      const resultado = await enviarMensagemFarmacia(
        ultimaFarmacia.telefone,
        ultimaFarmacia.nome,
        ultimoRemedio,
        endereco
      );
      
      if (resultado.success) {
        await msg.reply('✅ Pedido enviado! A farmácia foi contatada com estas informações:\n\n' +
                      `🏥 *Farmácia:* ${ultimaFarmacia.nome}\n` +
                      `💊 *Remédio:* ${ultimoRemedio}\n` +
                      `📍 *Endereço:* ${endereco}\n` +
                      `💵 *Pagamento:* Dinheiro\n\n` +
                      `Aguarde a resposta deles. Vou te avisar quando responderem!`);
        
        estado.aguardandoResposta = {
          farmacia: ultimaFarmacia.nome,
          numero: ultimaFarmacia.telefone,
          remedio: ultimoRemedio
        };
      } else {
        await msg.reply(`❌ ${resultado.message}\n\nVocê pode tentar entrar em contato manualmente pelo número: ${ultimaFarmacia.telefone}`);
      }
    } else if (respostaUsuario === 'não' || respostaUsuario === 'nao' || respostaUsuario === 'n' || respostaUsuario === 'no') {
      await msg.reply('❌ Pedido cancelado. Você pode entrar em contato manualmente se desejar.');
    } else {
      // Mantém no estado de confirmação se a resposta for inválida
      await msg.reply('❗ Por favor, responda *"SIM"* para confirmar o envio ou *"NÃO"* para cancelar.');
      return;
    }
    
    // Limpa os estados independente da resposta
    estado.aguardandoConfirmacao = false;
    estado.ultimaFarmacia = null;
    return;
  }

  // Mensagem genérica se não estiver em nenhum fluxo específico
  msg.reply('ℹ️ Para começar, me envie um áudio com o nome do remédio que você precisa ou digite "ajuda" para ver as opções.');
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