class SocketIOAdapter {
  constructor (socket, $socket) {
    this.socket = socket
    this.$socket = $socket

    console.log(socket)
    console.log($socket)

    var self = this
    socket.on('client_left', function (clientId) {
      self.trigger('client_left', clientId)
    })
    socket.on('set_name', function ([clientId, name]) {
      self.trigger('set_name', clientId, name)
    })
    socket.on('ack', function () { console.log('ack'); self.trigger('ack') })
    socket.on('operation', function ([clientId, operation, selection]) {
      console.log('SocketIOAdapter subscribe operation', clientId, operation, selection)
      self.trigger('operation', operation)
      self.trigger('selection', clientId, selection)
    })
    socket.on('selection', function ([clientId, selection]) {
      self.trigger('selection', clientId, selection)
    })
    socket.on('reconnect', function () {
      self.trigger('reconnect')
    })
  }

  sendOperation (revision, operation, selection) {
    console.log('SocketIOAdapter.sendOperation', revision, operation, selection)
    this.$socket.emit('operation', revision, operation, selection)
  }

  sendSelection (selection) {
    this.$socket.emit('selection', selection)
  }

  registerCallbacks (cb) {
    this.callbacks = cb
  }

  trigger (event) {
    var args = Array.prototype.slice.call(arguments, 1)
    var action = this.callbacks && this.callbacks[event]
    if (action) { action.apply(this, args) }
  }
}

export default SocketIOAdapter
