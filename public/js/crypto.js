/**
 * E2E Encryption Module
 * Uses AES-256-GCM with PBKDF2 key derivation from invite code
 * The server NEVER sees the plaintext â only encrypted blobs
 */

class E2ECrypto {
  constructor() {
    this.key = null;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }

  /**
   * Derive a 256-bit AES key from the invite code using PBKDF2
   * The invite code acts as the shared secret â anyone with it can decrypt
   */
  async deriveKey(inviteCode) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      this.encoder.encode(inviteCode),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    // Use a fixed salt derived from the invite code itself
    // This ensures all group members derive the same key
    const saltBuffer = await crypto.subtle.digest(
      'SHA-256',
      this.encoder.encode('private-chat-salt-' + inviteCode)
    );

    this.key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: new Uint8Array(saltBuffer),
        iterations: 310000, // OWASP recommended minimum
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    return this.key;
  }

  /**
   * Encrypt a plaintext message
   * Returns { ciphertext: base64, iv: base64 }
   */
  async encrypt(plaintext) {
    if (!this.key) throw new Error('Key not derived. Call deriveKey() first.');

    // Generate a random 12-byte IV for each message (required for AES-GCM)
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      this.key,
      this.encoder.encode(plaintext)
    );

    return {
      encrypted: this._arrayBufferToBase64(ciphertext),
      iv: this._arrayBufferToBase64(iv)
    };
  }

  /**
   * Decrypt an encrypted message
   */
  async decrypt(ciphertextBase64, ivBase64) {
    if (!this.key) throw new Error('Key not derived. Call deriveKey() first.');

    try {
      const ciphertext = this._base64ToArrayBuffer(ciphertextBase64);
      const iv = this._base64ToArrayBuffer(ivBase64);

      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        this.key,
        ciphertext
      );

      return this.decoder.decode(plaintext);
    } catch (err) {
      console.error('Decryption failed:', err);
      return '[ÙØ´Ù ÙÙ Ø§ÙØªØ´ÙÙØ±]';
    }
  }

  // âââ Helpers âââ
  _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  _base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

// Global instance
const e2e = new E2ECrypto();
