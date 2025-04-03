const { Client } = require('whatsapp-web.js');
const client = new Client();
client.on('qr', (qr) => console.log('QR Code:', qr));
client.on('ready', () => console.log('Client ready!'));
client.initialize();