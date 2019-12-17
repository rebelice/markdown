import TextOperation from './text-operation'
import Selection from './selection'

function bind (obj, method) {
  var fn = obj[method]
  obj[method] = function () {
    fn.apply(obj, arguments)
  }
}

function cmpPos (a, b) {
  if (a.line < b.line) { return -1 }
  if (a.line > b.line) { return 1 }
  if (a.ch < b.ch) { return -1 }
  if (a.ch > b.ch) { return 1 }
  return 0
}
// eslint-disable-next-line no-unused-vars
function posEq (a, b) { return cmpPos(a, b) === 0 }
function posLe (a, b) { return cmpPos(a, b) <= 0 }

function minPos (a, b) { return posLe(a, b) ? a : b }
function maxPos (a, b) { return posLe(a, b) ? b : a }

function codemirrorDocLength (doc) {
  return doc.indexFromPos({ line: doc.lastLine(), ch: 0 }) +
    doc.getLine(doc.lastLine()).length
}

const addStyleRule = (function () {
  var added = {}
  var styleElement = document.createElement('style')
  document.documentElement.getElementsByTagName('head')[0].appendChild(styleElement)
  var styleSheet = styleElement.sheet

  return function (css) {
    if (added[css]) { return }
    added[css] = true
    styleSheet.insertRule(css, (styleSheet.cssRules || styleSheet.rules).length)
  }
}())

class CodeMirrorAdapter {
  constructor (cm) {
    this.cm = cm
    this.ignoreNextChange = false
    this.changeInProgress = false
    this.selectionChanged = false

    bind(this, 'onChanges')
    bind(this, 'onChange')
    bind(this, 'onCursorActivity')
    bind(this, 'onFocus')
    bind(this, 'onBlur')

    cm.on('changes', this.onChanges)
    cm.on('change', this.onChange)
    cm.on('cursorActivity', this.onCursorActivity)
    cm.on('focus', this.onFocus)
    cm.on('blur', this.onBlur)
  }

  // Removes all event listeners from the CodeMirror instance.
  detach () {
    this.cm.off('changes', this.onChanges)
    this.cm.off('change', this.onChange)
    this.cm.off('cursorActivity', this.onCursorActivity)
    this.cm.off('focus', this.onFocus)
    this.cm.off('blur', this.onBlur)
  }

  static operationFromCodeMirrorChanges = function (changes, doc) {
    var docEndLength = codemirrorDocLength(doc)
    var operation = new TextOperation().retain(docEndLength)
    var inverse = new TextOperation().retain(docEndLength)

    var indexFromPos = function (pos) {
      return doc.indexFromPos(pos)
    }

    function last (arr) { return arr[arr.length - 1] }

    function sumLengths (strArr) {
      if (strArr.length === 0) { return 0 }
      var sum = 0
      for (var i = 0; i < strArr.length; i++) { sum += strArr[i].length }
      return sum + strArr.length - 1
    }

    function updateIndexFromPos (indexFromPos, change) {
      return function (pos) {
        if (posLe(pos, change.from)) { return indexFromPos(pos) }
        if (posLe(change.to, pos)) {
          return indexFromPos({
            line: pos.line + change.text.length - 1 - (change.to.line - change.from.line),
            ch: (change.to.line < pos.line)
              ? pos.ch
              : (change.text.length <= 1)
                ? pos.ch - (change.to.ch - change.from.ch) + sumLengths(change.text)
                : pos.ch - change.to.ch + last(change.text).length
          }) + sumLengths(change.removed) - sumLengths(change.text)
        }
        if (change.from.line === pos.line) {
          return indexFromPos(change.from) + pos.ch - change.from.ch
        }
        return indexFromPos(change.from) +
          sumLengths(change.removed.slice(0, pos.line - change.from.line)) +
          1 + pos.ch
      }
    }

    for (var i = changes.length - 1; i >= 0; i--) {
      var change = changes[i]
      indexFromPos = updateIndexFromPos(indexFromPos, change)

      var fromIndex = indexFromPos(change.from)
      var restLength = docEndLength - fromIndex - sumLengths(change.text)

      operation = new TextOperation()
        .retain(fromIndex)['delete'](sumLengths(change.removed))
        .insert(change.text.join('\n'))
        .retain(restLength)
        .compose(operation)

      inverse = inverse.compose(new TextOperation()
        .retain(fromIndex)['delete'](sumLengths(change.text))
        .insert(change.removed.join('\n'))
        .retain(restLength)
      )

      docEndLength += sumLengths(change.removed) - sumLengths(change.text)
    }

    return [operation, inverse]
  }

  // Apply an operation to a CodeMirror instance.
  static applyOperationToCodeMirror = function (operation, cm) {
    cm.operation(function () {
      var ops = operation.ops
      var index = 0 // holds the current index into CodeMirror's content
      for (var i = 0, l = ops.length; i < l; i++) {
        var op = ops[i]
        if (TextOperation.isRetain(op)) {
          index += op
        } else if (TextOperation.isInsert(op)) {
          cm.replaceRange(op, cm.posFromIndex(index))
          index += op.length
        } else if (TextOperation.isDelete(op)) {
          var from = cm.posFromIndex(index)
          var to = cm.posFromIndex(index - op)
          cm.replaceRange('', from, to)
        }
      }
    })
  }

  // Singular form for backwards compatibility.
  static operationFromCodeMirrorChange = CodeMirrorAdapter.operationFromCodeMirrorChanges

  registerCallbacks (cb) {
    this.callbacks = cb
  }

  onChange () {
    this.changeInProgress = true
  }

  onChanges (_, changes) {
    if (!this.ignoreNextChange) {
      var pair = CodeMirrorAdapter.operationFromCodeMirrorChanges(changes, this.cm)
      this.trigger('change', pair[0], pair[1])
    }
    if (this.selectionChanged) { this.trigger('selectionChange') }
    this.changeInProgress = false
    this.ignoreNextChange = false
  }

  onFocus () {
    if (this.changeInProgress) {
      this.selectionChanged = true
    } else {
      this.trigger('selectionChange')
    }
  }

  onCursorActivity () {
    if (this.changeInProgress) {
      this.selectionChanged = true
    } else {
      this.trigger('selectionChange')
    }
  }

  onBlur () {
    if (!this.cm.somethingSelected()) { this.trigger('blur') }
  }

  getValue () {
    return this.cm.getValue()
  }

  getSelection () {
    var cm = this.cm

    var selectionList = cm.listSelections()
    var ranges = []
    for (var i = 0; i < selectionList.length; i++) {
      ranges[i] = new Selection.Range(
        cm.indexFromPos(selectionList[i].anchor),
        cm.indexFromPos(selectionList[i].head)
      )
    }

    return new Selection(ranges)
  }

  setSelection (selection) {
    var ranges = []
    for (var i = 0; i < selection.ranges.length; i++) {
      var range = selection.ranges[i]
      ranges[i] = {
        anchor: this.cm.posFromIndex(range.anchor),
        head: this.cm.posFromIndex(range.head)
      }
    }
    this.cm.setSelections(ranges)
  }

  setOtherCursor (position, color, clientId) {
    var cursorPos = this.cm.posFromIndex(position)
    var cursorCoords = this.cm.cursorCoords(cursorPos)
    var cursorEl = document.createElement('span')
    cursorEl.className = 'other-client'
    cursorEl.style.display = 'inline-block'
    cursorEl.style.padding = '0'
    cursorEl.style.marginLeft = cursorEl.style.marginRight = '-1px'
    cursorEl.style.borderLeftWidth = '2px'
    cursorEl.style.borderLeftStyle = 'solid'
    cursorEl.style.borderLeftColor = color
    cursorEl.style.height = (cursorCoords.bottom - cursorCoords.top) * 0.9 + 'px'
    cursorEl.style.zIndex = 0
    cursorEl.setAttribute('data-clientid', clientId)
    return this.cm.setBookmark(cursorPos, { widget: cursorEl, insertLeft: true })
  }

  setOtherSelectionRange (range, color, clientId) {
    var match = /^#([0-9a-fA-F]{6})$/.exec(color)
    if (!match) { throw new Error('only six-digit hex colors are allowed.') }
    var selectionClassName = 'selection-' + match[1]
    var rule = '.' + selectionClassName + ' { background: ' + color + '; }'
    addStyleRule(rule)

    var anchorPos = this.cm.posFromIndex(range.anchor)
    var headPos = this.cm.posFromIndex(range.head)

    return this.cm.markText(
      minPos(anchorPos, headPos),
      maxPos(anchorPos, headPos),
      { className: selectionClassName }
    )
  }

  setOtherSelection (selection, color, clientId) {
    var selectionObjects = []
    for (var i = 0; i < selection.ranges.length; i++) {
      var range = selection.ranges[i]
      if (range.isEmpty()) {
        selectionObjects[i] = this.setOtherCursor(range.head, color, clientId)
      } else {
        selectionObjects[i] = this.setOtherSelectionRange(range, color, clientId)
      }
    }
    return {
      clear: function () {
        for (var i = 0; i < selectionObjects.length; i++) {
          selectionObjects[i].clear()
        }
      }
    }
  }

  trigger (event) {
    var args = Array.prototype.slice.call(arguments, 1)
    var action = this.callbacks && this.callbacks[event]
    if (action) { action.apply(this, args) }
  }

  applyOperation (operation) {
    this.ignoreNextChange = true
    CodeMirrorAdapter.applyOperationToCodeMirror(operation, this.cm)
  }
}

export default CodeMirrorAdapter
