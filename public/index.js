const io = require('socket.io-client')
const mediasoupClient = require('mediasoup-client')


let device
let socket = io('/mediasoup')

// Step 1: Connect to server
socket.on('connect', () => {
  console.log('Connected to server:', socket.id)
})