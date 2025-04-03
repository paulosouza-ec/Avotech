const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const vosk = require('vosk');

console.log('Iniciando o bot...');

// Configuração do cliente WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "bot",
        dataPath: path.join(__dirname, 'wwebjs_auth')
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-extensions',
            '--disable-gpu'
        ]
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
});

// Configuração do Vosk
const MODEL_PATH = path.join(__dirname, 'model');
const SAMPLE_RATE = 16000;

console.log('Verificando modelo Vosk...');
if (!fs.existsSync(MODEL_PATH)) {
    console.error('ERRO: Modelo Vosk não encontrado em', MODEL_PATH);
    console.error('Baixe o modelo em: https://alphacephei.com/vosk/models');
    process.exit(1);
}

vosk.setLogLevel(-1);
const model = new vosk.Model(MODEL_PATH);
console.log('Modelo Vosk carregado com sucesso!');

// Função de transcrição de áudio
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

                stream.on('data', (data) => {
                    if (recognizer.acceptWaveform(data)) {
                        transcript += recognizer.result().text + ' ';
                    }
                });

                stream.on('end', () => {
                    transcript += recognizer.finalResult().text;
                    recognizer.free();
                    
                    // Limpeza dos arquivos temporários
                    [audioPath, wavPath].forEach(file => {
                        try { fs.unlinkSync(file); } 
                        catch (err) { console.error('Erro ao apagar', file, err); }
                    });
                    
                    resolve(transcript.trim());
                });
            })
            .on('error', reject)
            .save(wavPath);
    });
}

// Eventos do WhatsApp
client.on('qr', qr => {
    console.log('[QR CODE] Escaneie este código:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('[PRONTO] Bot conectado!');
});

client.on('message', async msg => {
    if (msg.hasMedia && msg.type === 'ptt') {
        console.log('Áudio recebido, processando...');
        
        try {
            const media = await msg.downloadMedia();
            const audioPath = path.join(__dirname, `audio_${Date.now()}.ogg`);
            fs.writeFileSync(audioPath, Buffer.from(media.data, 'base64'));
            
            const transcricao = await transcreverAudio(audioPath);
            
            if (transcricao) {
                await msg.reply(`🔊 Transcrição:\n${transcricao}`);
                console.log('Transcrição enviada:', transcricao);
            } else {
                await msg.reply('❌ Não consegui transcrever o áudio');
            }
        } catch (err) {
            console.error('Erro no processamento:', err);
            msg.reply('⚠️ Ocorreu um erro ao processar o áudio');
        }
    }
});

// Inicialização com tratamento de erros
client.initialize().catch(err => {
    console.error('Falha na inicialização:', err);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    console.error('Erro não tratado:', err);
});