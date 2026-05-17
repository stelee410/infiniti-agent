import { describe, expect, it } from 'vitest'
import { isRecoverableUpstreamError } from './recoverableError.js'

describe('isRecoverableUpstreamError', () => {
  it('treats HTTP 5xx as recoverable', () => {
    expect(isRecoverableUpstreamError({ status: 500 })).toBe(true)
    expect(isRecoverableUpstreamError({ status: 502, message: 'no body' })).toBe(true)
    expect(isRecoverableUpstreamError({ status: 503 })).toBe(true)
    expect(isRecoverableUpstreamError({ statusCode: 504 })).toBe(true)
  })

  it('treats 408 / 413 / 429 as recoverable', () => {
    expect(isRecoverableUpstreamError({ status: 408 })).toBe(true)
    expect(isRecoverableUpstreamError({ status: 413 })).toBe(true)
    expect(isRecoverableUpstreamError({ status: 429 })).toBe(true)
  })

  it('treats context-length / too-long messages as recoverable', () => {
    expect(isRecoverableUpstreamError({ status: 400, message: 'context length exceeded' })).toBe(true)
    expect(isRecoverableUpstreamError({ message: 'input is too long for the model' })).toBe(true)
    expect(isRecoverableUpstreamError({ message: 'maximum context exceeded' })).toBe(true)
    expect(isRecoverableUpstreamError({ message: 'max_tokens reached' })).toBe(true)
  })

  it('treats Node connection errors as recoverable', () => {
    expect(isRecoverableUpstreamError({ code: 'ETIMEDOUT' })).toBe(true)
    expect(isRecoverableUpstreamError({ code: 'ECONNRESET' })).toBe(true)
    expect(isRecoverableUpstreamError({ code: 'ECONNREFUSED' })).toBe(true)
  })

  it('does not retry generic 4xx client errors', () => {
    expect(isRecoverableUpstreamError({ status: 400, message: 'bad request' })).toBe(false)
    expect(isRecoverableUpstreamError({ status: 401 })).toBe(false)
    expect(isRecoverableUpstreamError({ status: 403 })).toBe(false)
    expect(isRecoverableUpstreamError({ status: 404 })).toBe(false)
  })

  it('returns false for non-object errors', () => {
    expect(isRecoverableUpstreamError(null)).toBe(false)
    expect(isRecoverableUpstreamError(undefined)).toBe(false)
    expect(isRecoverableUpstreamError('error')).toBe(false)
    expect(isRecoverableUpstreamError(42)).toBe(false)
  })
})
