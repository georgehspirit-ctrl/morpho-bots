import type { Hex } from 'viem'

import { bytesToHex, getAddress, hexToBytes } from 'viem'
import { describe, expect, test } from 'vitest'

import {
  parseAddress,
  parseBytes32,
  referenceLookbackSecondsValue
} from '../../src/config/config.utils'

describe('config viem parsing utilities', () => {
  test('normalizes lowercase and valid mixed-case addresses to checksum form', () => {
    const lower = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a'
    expect(parseAddress(lower, 'ADDRESS')).toBe(getAddress(lower))
    expect(parseAddress(getAddress(lower), 'ADDRESS')).toBe(getAddress(lower))
  })

  test('normalizes arbitrary mixed case and rejects malformed addresses', () => {
    expect(() => parseAddress('0x1234', 'ADDRESS')).toThrow('ADDRESS must be an EVM address')
    expect(parseAddress('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2b', 'ADDRESS')).toBe(
      getAddress('0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2b')
    )
    expect(() => parseAddress('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2z', 'ADDRESS')).toThrow(
      'ADDRESS must be an EVM address'
    )
  })

  test('accepts exactly 32 bytes and rejects adjacent size boundaries', () => {
    expect(parseBytes32(`0x${'11'.repeat(32)}`, 'ID')).toBe(`0x${'11'.repeat(32)}`)
    expect(() => parseBytes32(`0x${'11'.repeat(31)}`, 'ID')).toThrow('32-byte')
    expect(() => parseBytes32(`0x${'11'.repeat(33)}`, 'ID')).toThrow('32-byte')
    expect(() => parseBytes32('0xzz', 'ID')).toThrow('32-byte')
  })

  test('canonicalizes mixed-case bytes32 values through viem', () => {
    const mixedCase: Hex = `0x${'aB'.repeat(32)}`

    expect(parseBytes32(mixedCase, 'ID')).toBe(bytesToHex(hexToBytes(mixedCase)))
  })
})

describe('referenceLookbackSecondsValue', () => {
  test('defaults to three days when absent or blank', () => {
    expect(referenceLookbackSecondsValue({})).toBe(259_200n)
    expect(referenceLookbackSecondsValue({ REFERENCE_LOOKBACK_SECONDS: '   ' })).toBe(259_200n)
  })

  test('accepts an explicit window inside the supported range', () => {
    expect(referenceLookbackSecondsValue({ REFERENCE_LOOKBACK_SECONDS: '21600' })).toBe(21_600n)
    expect(referenceLookbackSecondsValue({ REFERENCE_LOOKBACK_SECONDS: ' 3600 ' })).toBe(3_600n)
    expect(referenceLookbackSecondsValue({ REFERENCE_LOOKBACK_SECONDS: '2592000' })).toBe(
      2_592_000n
    )
  })

  test('rejects windows outside one hour through thirty days', () => {
    for (const value of ['0', '3599', '2592001']) {
      expect(() => referenceLookbackSecondsValue({ REFERENCE_LOOKBACK_SECONDS: value })).toThrow(
        'REFERENCE_LOOKBACK_SECONDS must be between 3600 and 2592000'
      )
    }
  })

  test('rejects non-decimal notation rather than coercing it', () => {
    for (const value of ['2.592e5', '+259200', '259200.0', '0x3f480', 'three days']) {
      expect(() => referenceLookbackSecondsValue({ REFERENCE_LOOKBACK_SECONDS: value })).toThrow(
        'REFERENCE_LOOKBACK_SECONDS must be a decimal integer'
      )
    }
  })
})
