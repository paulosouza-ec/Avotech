const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const vosk = require('vosk');

const AUDIO_ORIGINAL = path.join(__dirname, 'teste.ogg'); // Renomeie se necessário
const AUDIO_CONVERTIDO = path.join(__dirname, 'teste.wav');
const MODEL_PATH = path.join(__dirname, 'model');
const SAMPLE_RATE = 16000;

async function converterAudio(input, output) {
    return new Promise((resolve, reject) => {
        ffmpeg(input)
            .outputOptions([
                '-acodec pcm_s16le',
                '-ac 1',
                '-ar 16000'
            ])
            .format('wav')
            .on('end', () => {
                console.log('[OK] Conversão concluída');
                resolve();
            })
            .on('error', reject)
            .save(output);
    });
}

async function transcreverAudio(wavPath) {
    const model = new vosk.Model(MODEL_PATH);
    const recognizer = new vosk.Recognizer({ model, sampleRate: SAMPLE_RATE });

    const stream = fs.createReadStream(wavPath);
    let resultado = '';

    stream.on('data', (data) => {
        if (recognizer.acceptWaveform(data)) {
            resultado += recognizer.result().text + ' ';
        }
    });

    stream.on('end', () => {
        resultado += recognizer.finalResult().text;
        console.log('\n📝 Transcrição final:\n', resultado.trim());
        recognizer.free();
        model.free();
    });
}

(async () => {
    try {
        console.log('[1] Convertendo o áudio...');
        await converterAudio(AUDIO_ORIGINAL, AUDIO_CONVERTIDO);

        console.log('[2] Transcrevendo o áudio...');
        await transcreverAudio(AUDIO_CONVERTIDO);
    } catch (err) {
        console.error('❌ Erro durante o teste:', err);
    }
})();
