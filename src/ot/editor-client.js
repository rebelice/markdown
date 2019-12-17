import TextOperation from './text-operation'
import Client from './client'
import Selection from './selection'

function rgb2hex (r, g, b) {
  function digits (n) {
    var m = Math.round(255 * n).toString(16)
    return m.length === 1 ? '0' + m : m
  }
  return '#' + digits(r) + digits(g) + digits(b)
}

function hsl2hex (h, s, l) {
  if (s === 0) { return rgb2hex(l, l, l) }
  var var2 = l < 0.5 ? l * (1 + s) : (l + s) - (s * l)
  var var1 = 2 * l - var2
  var hue2rgb = function (hue) {
    if (hue < 0) { hue += 1 }
    if (hue > 1) { hue -= 1 }
    if (6 * hue < 1) { return var1 + (var2 - var1) * 6 * hue }
    if (2 * hue < 1) { return var2 }
    if (3 * hue < 2) { return var1 + (var2 - var1) * 6 * (2 / 3 - hue) }
    return var1
  }
  return rgb2hex(hue2rgb(h + 1 / 3), hue2rgb(h), hue2rgb(h - 1 / 3))
}

function hueFromName (name) {
  var a = 1
  for (var i = 0; i < name.length; i++) {
    a = 17 * (a + name.charCodeAt(i)) % 360
  }
  return a / 360
}

// Remove an element from the DOM.
function removeElement (el) {
  if (el.parentNode) {
    el.parentNode.removeChild(el)
  }
}

class OtherClient {
  constructor (id, listEl, editorAdapter, name, selection) {
    this.id = id
    this.listEl = listEl
    this.editorAdapter = editorAdapter
    this.name = name

    this.li = document.createElement('li')
    if (name) {
      this.li.textContent = name
      this.listEl.appendChild(this.li)
    }

    this.setColor(name ? hueFromName(name) : Math.random())
    if (selection) { this.updateSelection(selection) }
  }

  setColor (hue) {
    this.hue = hue
    this.color = hsl2hex(hue, 0.75, 0.5)
    this.lightColor = hsl2hex(hue, 0.5, 0.9)
    if (this.li) { this.li.style.color = this.color }
  }

  setName (name) {
    if (this.name === name) { return }
    this.name = name

    this.li.textContent = name
    if (!this.li.parentNode) {
      this.listEl.appendChild(this.li)
    }

    this.setColor(hueFromName(name))
  }

  updateSelection (selection) {
    this.removeSelection()
    this.selection = selection
    this.mark = this.editorAdapter.setOtherSelection(
      selection,
      selection.position === selection.selectionEnd ? this.color : this.lightColor,
      this.id
    )
  }

  remove () {
    if (this.li) { removeElement(this.li) }
    this.removeSelection()
  }

  removeSelection () {
    if (this.mark) {
      this.mark.clear()
      this.mark = null
    }
  }
}

class EditorClient extends Client {
  constructor (revision, clients, serverAdapter, editorAdapter) {
    super(revision)
    this.serverAdapter = serverAdapter
    this.editorAdapter = editorAdapter

    this.initializeClientList()
    this.initializeClients(clients)

    var self = this

    this.editorAdapter.registerCallbacks({
      change: function (operation, inverse) {
        self.onChange(operation, inverse)
      },
      selectionChange: function () { self.onSelectionChange() },
      blur: function () { self.onBlur() }
    })

    this.serverAdapter.registerCallbacks({
      client_left: function (clientId) { self.onClientLeft(clientId) },
      set_name: function (clientId, name) { self.getClientObject(clientId).setName(name) },
      ack: function () {
        console.log('this.serverAdapter.registerCallbacks ack')
        self.serverAck()
      },
      operation: function (operation) {
        console.log('serverAdapter -> operation', operation)
        self.applyServer(TextOperation.fromJSON(operation))
      },
      selection: function (clientId, selection) {
        if (selection) {
          self.getClientObject(clientId).updateSelection(
            self.transformSelection(Selection.fromJSON(selection))
          )
        } else {
          self.getClientObject(clientId).removeSelection()
        }
      },
      clients: function (clients) {
        var clientId
        for (clientId in self.clients) {
          if (self.clients.hasOwnProperty(clientId) && !clients.hasOwnProperty(clientId)) {
            self.onClientLeft(clientId)
          }
        }

        for (clientId in clients) {
          if (clients.hasOwnProperty(clientId)) {
            var clientObject = self.getClientObject(clientId)

            if (clients[clientId].name) {
              clientObject.setName(clients[clientId].name)
            }

            var selection = clients[clientId].selection
            if (selection) {
              self.clients[clientId].updateSelection(
                self.transformSelection(Selection.fromJSON(selection))
              )
            } else {
              self.clients[clientId].removeSelection()
            }
          }
        }
      },
      reconnect: function () { self.serverReconnect() }
    })
  }

  addClient (clientId, clientObj) {
    this.clients[clientId] = new OtherClient(
      clientId,
      this.clientListEl,
      this.editorAdapter,
      clientObj.name || clientId,
      clientObj.selection ? Selection.fromJSON(clientObj.selection) : null
    )
  }

  initializeClients (clients) {
    this.clients = {}
    for (var clientId in clients) {
      if (clients.hasOwnProperty(clientId)) {
        this.addClient(clientId, clients[clientId])
      }
    }
  }

  getClientObject (clientId) {
    var client = this.clients[clientId]
    if (client) { return client }
    this.clients[clientId] = new OtherClient(
      clientId,
      this.clientListEl,
      this.editorAdapter
    )
    return this.clients[clientId]
  }

  onClientLeft (clientId) {
    console.log('User disconnected: ' + clientId)
    var client = this.clients[clientId]
    if (!client) { return }
    client.remove()
    delete this.clients[clientId]
  }

  initializeClientList () {
    this.clientListEl = document.createElement('ul')
  }

  onChange (textOperation, inverse) {
    this.updateSelection()
    this.applyClient(textOperation)
  }

  updateSelection () {
    this.selection = this.editorAdapter.getSelection()
  }

  onSelectionChange () {
    var oldSelection = this.selection
    this.updateSelection()
    if (oldSelection && this.selection.equals(oldSelection)) { return }
    this.sendSelection(this.selection)
  }

  onBlur () {
    this.selection = null
    this.sendSelection(null)
  }

  sendSelection (selection) {
    if (this.state instanceof Client.AwaitingWithBuffer) { return }
    this.serverAdapter.sendSelection(selection)
  }

  sendOperation (revision, operation) {
    console.log('EditorClient.sendOperation', revision, operation)
    this.serverAdapter.sendOperation(revision, operation.toJSON(), this.selection)
  }

  applyOperation (operation) {
    this.editorAdapter.applyOperation(operation)
    this.updateSelection()
  }
}

export default EditorClient
