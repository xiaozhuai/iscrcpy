import { createSocket, type Socket } from 'dgram'

export interface RtpSocketPair {
  rtp: Socket
  rtcp: Socket
  port: number
  close: () => void
}

function close(socket: Socket): void {
  try {
    socket.close()
  } catch {
    // A failed bind may have already closed the socket.
  }
}

function bind(socket: Socket, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    socket.once('error', onError)
    socket.bind({ address: '127.0.0.1', port, exclusive: true }, () => {
      socket.off('error', onError)
      resolve()
    })
  })
}

// Reserve *both* ports. mini always sends RTCP to RTP + 1.
export async function bindRtpSocketPair(): Promise<RtpSocketPair> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const rtp = createSocket('udp4')
    const rtcp = createSocket('udp4')
    try {
      await bind(rtp, 0)
      const port = rtp.address().port
      if (port === 65535) {
        close(rtp)
        close(rtcp)
        continue
      }
      await bind(rtcp, port + 1)
      return {
        rtp,
        rtcp,
        port,
        close: () => {
          close(rtp)
          close(rtcp)
        }
      }
    } catch (error) {
      close(rtp)
      close(rtcp)
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error('Could not reserve a local RTP/RTCP port pair')
}
