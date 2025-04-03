const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const vosk = require('vosk');

const client = new Client({
    authStrategy: new LocalAuth({ clientId: "bot" }),
    webVersionCache: { type: "none" }
});

const MODEL_PATH = "model";  // Caminho para o modelo do Vosk
const SAMPLE_RATE = 16000;   // Taxa de amostragem para reconhecimento de voz

// Configurando o modelo Vosk
if (!fs.existsSync(MODEL_PATH)) {
    console.error("O modelo Vosk não foi encontrado! Baixe em: https://alphacephei.com/vosk/models");
    process.exit(1);
}
vosk.setLogLevel(0);
const model = new vosk.Model(MODEL_PATH);

// Função para converter áudio para .wav e reconhecer fala
const processAudio = async (audioPath) => {
    return new Promise((resolve, reject) => {
        const wavPath = audioPath.replace('.ogg', '.wav');

        // Converter para WAV usando ffmpeg
        ffmpeg(audioPath)
            .toFormat('wav')
            .audioFrequency(SAMPLE_RATE)
            .on('end', async () => {
                const recognizer = new vosk.Recognizer({ model, sampleRate: SAMPLE_RATE });
                const audioStream = fs.createReadStream(wavPath);
                
                let transcript = "";
                audioStream.on("data", (data) => {
                    const result = recognizer.acceptWaveform(data);
                    if (result) transcript += recognizer.result().text + " ";
                });

                audioStream.on("end", () => {
                    recognizer.free();
                    fs.unlinkSync(audioPath); // Remove o arquivo original
                    fs.unlinkSync(wavPath);   // Remove o arquivo convertido
                    resolve(transcript.trim());
                });

            })
            .on('error', (err) => reject(err))
            .save(wavPath);
    });
};

// Evento para capturar mensagens
client.on('message', async message => {
    const msg = message.body.toLowerCase();

    if (msg === 'oi') {
        message.reply('Olá! Qual medicamento você precisa?');
    } else if (msg.includes('preciso de') || msg.includes('quero comprar')) {
        let medicamento = msg.replace('preciso de', '').replace('quero comprar', '').trim();
        if (medicamento) {
            let link = `https://www.ifood.com.br/busca?q=${encodeURIComponent(medicamento)}`;
            message.reply(`Aqui está o link para buscar "${medicamento}" no iFood: ${link}\n\nPara finalizar a compra, escolha "Pagamento em Dinheiro" na entrega.`);
        } else {
            message.reply('Por favor, me diga o nome do medicamento.');
        }
    }

    // Se a mensagem for um áudio (PTT - Push to Talk)
    if (message.hasMedia && message.type === 'ptt') {
        const media = await message.downloadMedia();
        const audioPath = `audio_${message.id.id}.ogg`;
        fs.writeFileSync(audioPath, Buffer.from(media.data, 'base64'));

        try {
            const transcript = await processAudio(audioPath);
            if (transcript) {
                let link = `https://www.ifood.com.br/busca?q=${encodeURIComponent(transcript)}`;
                message.reply(`Reconheci: "${transcript}". Aqui está o link no iFood: ${link}`);
            } else {
                message.reply("Não consegui entender o que foi dito. Pode tentar novamente?");
            }
        } catch (error) {
            console.error("Erro no processamento de áudio:", error);
            message.reply("Houve um erro ao processar o áudio. Tente novamente.");
        }
    }
});

// Inicializando o bot
client.on('qr', qr => {
    console.log('QR Code gerado! Escaneie com seu WhatsApp.');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Bot está pronto!');
});

client.initialize();
