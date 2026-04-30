import { describe, expect, it, vi } from 'vitest'
import { isSocketOpen, sendSocketMessage, SOCKET_OPEN, type SocketLike } from './socketMessages.js'

describe('socketMessages', () => {
  it('detects open sockets using the WebSocket readyState value', () => {
    expect(isSocketOpen({ readyState: SOCKET_OPEN })).toBe(true)
    expect(isSocketOpen({ readyState: 0 })).toBe(false)
    expect(isSocketOpen({ readyState: 3 })).toBe(false)
  })

  it('sends JSON messages only when the socket is open', () => {
    const socket: SocketLike = {
      readyState: SOCKET_OPEN,
      send: vi.fn(),
    }

    expect(sendSocketMessage(socket, 'USER_COMPOSER', { text: 'hi' })).toBe(true)
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'USER_COMPOSER',
      data: { text: 'hi' },
    }))
  })

  it('returns false without sending when the socket is closed', () => {
    const socket: SocketLike = {
      readyState: 3,
      send: vi.fn(),
    }

    expect(sendSocketMessage(socket, 'INTERRUPT')).toBe(false)
    expect(socket.send).not.toHaveBeenCalled()
  })
})
