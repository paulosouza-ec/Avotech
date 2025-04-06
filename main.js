
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const vosk = require('vosk');
const axios = require('axios');

const MODEL_PATH = path.join(__dirname, 'model');
const SAMPLE_RATE = 16000;

const userStates = {}; // Armazena estado por número

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
  return resp.data.elements.map(e => {
    const tags = e.tags || {};

    const partes = [
      tags['addr:full'],
      tags['addr:street'],
      tags['addr:housenumber'],
      tags['addr:suburb'],
      tags['addr:city'],
      tags['addr:postcode']
    ].filter(Boolean);

    const endereco = partes.length > 0 ? partes.join(', ') : 'Endereço não informado';

    return {
      nome: tags.name || 'Farmácia sem nome',
      endereco
    };
  });
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


client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', () => {
  console.log('✅ Bot conectado!');
});

client.on('message', async msg => {
  const userId = msg.from;
  if (!userStates[userId]) userStates[userId] = {};

  const estado = userStates[userId];

  // Receber endereço
  if (estado.esperandoEndereco) {
    estado.endereco = msg.body;
    estado.esperandoEndereco = false;
    msg.reply('📍 Obrigado! Agora me envie um áudio dizendo o nome do remédio que você precisa.');
    return;
  }

  // Mensagem de boas-vindas
  if (msg.body.toLowerCase().includes('oi') || msg.body.toLowerCase().includes('olá')) {
    return msg.reply('👋 Olá! Que bom falar com você 😊. Eu sou um assistente virtual e posso te ajudar a encontrar farmácias próximas com o remédio que você precisa. Me envie um áudio com o nome do remédio ou escreva aqui o que deseja.');
  }

  // Processar áudio
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

  // Escolha de farmácia
  if (estado.escolhendoFarmacia) {
    const escolha = parseInt(msg.body.trim());
    const { opcoes, ultimoRemedio } = estado;

    if (!isNaN(escolha) && escolha >= 1 && escolha <= opcoes.length) {
      const farmaciaEscolhida = opcoes[escolha - 1];
      msg.reply(`✉️ Ótimo! Agora você pode ligar ou mandar mensagem para a farmácia:\n\n*${farmaciaEscolhida.nome}*\n📍 ${farmaciaEscolhida.endereco}\n\nMensagem sugerida:\n"Olá! Gostaria de saber se vocês têm o remédio ${ultimoRemedio} e qual o valor. Obrigado!"`);

      estado.escolhendoFarmacia = false;
    } else {
      msg.reply('❗ Por favor, envie um número válido da lista.');
    }
  }
});

client.initialize();
