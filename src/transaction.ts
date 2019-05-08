import {
  BN,
  defineProperties,
  bufferToInt,
  ecrecover,
  rlphash,
  publicToAddress,
  ecsign,
  toBuffer,
  rlp,
} from 'ethereumjs-util'
import Common from 'ethereumjs-common'
import { Buffer } from 'buffer'
import { BufferLike, PrefixedHexString, TxData, TransactionOptions } from './types'

// secp256k1n/2
const N_DIV_2 = new BN('7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0', 16)

/**
 * An Ethereum transaction.
 */
export default class Transaction {
  public raw!: Buffer[]
  public nonce!: Buffer
  public gasLimit!: Buffer
  public gasPrice!: Buffer
  public to!: Buffer
  public value!: Buffer
  public data!: Buffer
  public v!: Buffer
  public r!: Buffer
  public s!: Buffer

  private _common: Common
  private _chainId: number
  private _senderPubKey?: Buffer
  protected _from?: Buffer

  /**
   * Creates a new transaction from an object with its fields' values.
   *
   * @param data - A transaction can be initialized with its rlp representation, an array containing
   * the value of its fields in order, or an object containing them by name. If the latter is used,
   * a `chainId` can also be provided.
   *
   * @param opts - The transaction's options, used to indicate the chain and hardfork the
   * transactions belongs to.
   *
   * @example
   * ```js
   * const txData = {
   *   nonce: '0x00',
   *   gasPrice: '0x09184e72a000',
   *   gasLimit: '0x2710',
   *   to: '0x0000000000000000000000000000000000000000',
   *   value: '0x00',
   *   data: '0x7f7465737432000000000000000000000000000000000000000000000000000000600057',
   *   v: '0x1c',
   *   r: '0x5e1d3a76fbf824220eafc8c79ad578ad2b67d01b0c2425eb1f1347e8f50882ab',
   *   s: '0x5bd428537f05f9830e93792f90ea6a3e2d1ee84952dd96edbae9f658f831ab13'
   * };
   * const tx = new Transaction(txData);
   * ```
   */
  constructor(
    data: Buffer | PrefixedHexString | BufferLike[] | TxData = {},
    opts: TransactionOptions = {},
  ) {
    // instantiate Common class instance based on passed options
    if (opts.common) {
      if (opts.chain) {
        throw new Error('Instantiation with both opts.common and opts.chain parameter not allowed!')
      }
      this._common = opts.common
    } else {
      const chain = opts.chain ? opts.chain : 'mainnet'
      const hardfork = opts.hardfork ? opts.hardfork : 'byzantium'
      this._common = new Common(chain, hardfork)
    }

    // Define Properties
    const fields = [
      {
        name: 'nonce',
        length: 32,
        allowLess: true,
        default: new Buffer([]),
      },
      {
        name: 'gasPrice',
        length: 32,
        allowLess: true,
        default: new Buffer([]),
      },
      {
        name: 'gasLimit',
        alias: 'gas',
        length: 32,
        allowLess: true,
        default: new Buffer([]),
      },
      {
        name: 'to',
        allowZero: true,
        length: 20,
        default: new Buffer([]),
      },
      {
        name: 'value',
        length: 32,
        allowLess: true,
        default: new Buffer([]),
      },
      {
        name: 'data',
        alias: 'input',
        allowZero: true,
        default: new Buffer([]),
      },
      {
        name: 'v',
        allowZero: true,
        default: new Buffer([opts.chain || opts.common ? this._common.chainId() : 0x1c]),
      },
      {
        name: 'r',
        length: 32,
        allowZero: true,
        default: new Buffer([]),
      },
      {
        name: 's',
        length: 32,
        allowZero: true,
        default: new Buffer([]),
      },
    ]

    /**
     * Returns the transaction in JSON format
     * @method toJSON
     * @return {Array | String}
     * @memberof Transaction
     * @name toJSON
     * @see {@link https://github.com/ethereumjs/ethereumjs-util/blob/master/docs/index.md#defineproperties|ethereumjs-util}
     */

    // attached serialize
    defineProperties(this, fields, data)

    /**
     * @property {Buffer} from (read only) sender address of this transaction, mathematically derived from other parameters.
     * @name from
     * @memberof Transaction
     */
    Object.defineProperty(this, 'from', {
      enumerable: true,
      configurable: true,
      get: this.getSenderAddress.bind(this),
    })

    // calculate chainId from signature
    const sigV = bufferToInt(this.v)
    let chainId = Math.floor((sigV - 35) / 2)
    if (chainId < 0) chainId = 0

    // set chainId
    if (opts.chain || opts.common) {
      this._chainId = this._common.chainId()
    } else {
      const dataAsTransactionObject = data as TxData
      this._chainId = chainId || dataAsTransactionObject.chainId || 0
    }
  }

  /**
   * If the tx's `to` is to the creation address
   */
  toCreationAddress(): boolean {
    return this.to.toString('hex') === ''
  }

  /**
   * Computes a sha3-256 hash of the serialized tx
   * @param includeSignature - Whether or not to include the signature
   */
  hash(includeSignature: boolean = true): Buffer {
    let items
    if (includeSignature) {
      items = this.raw
    } else {
      // EIP155 spec:
      // If block.number >= 2,675,000 and v = CHAIN_ID * 2 + 35 or v = CHAIN_ID * 2 + 36, then when computing
      // the hash of a transaction for purposes of signing or recovering, instead of hashing only the first six
      // elements (i.e. nonce, gasprice, startgas, to, value, data), hash nine elements, with v replaced by
      // CHAIN_ID, r = 0 and s = 0.

      const v = bufferToInt(this.v)
      const onEIP155BlockOrLater = this._common.gteHardfork('spuriousDragon')
      const vAndChainIdMeetEIP155Conditions =
        v === this._chainId * 2 + 35 || v === this._chainId * 2 + 36
      const meetsAllEIP155Conditions = vAndChainIdMeetEIP155Conditions && onEIP155BlockOrLater

      const unsigned = !this.r.length && !this.s.length
      const seeksReplayProtection = this._chainId > 0

      if ((unsigned && seeksReplayProtection) || (!unsigned && meetsAllEIP155Conditions)) {
        const raw = this.raw.slice()
        const emptyBuffer = toBuffer('')
        this.v = toBuffer(this._chainId)
        this.raw[7] = emptyBuffer
        this.raw[8] = emptyBuffer
        items = this.raw
        this.raw = raw
      } else {
        items = this.raw.slice(0, 6)
      }
    }

    // create hash
    return rlphash(items)
  }

  /**
   * returns chain ID
   */
  getChainId(): number {
    return this._chainId
  }

  /**
   * returns the sender's address
   */
  getSenderAddress(): Buffer {
    if (this._from) {
      return this._from
    }
    const pubkey = this.getSenderPublicKey()
    this._from = publicToAddress(pubkey)
    return this._from
  }

  /**
   * returns the public key of the sender
   */
  getSenderPublicKey(): Buffer {
    if (!this.verifySignature()) {
      throw new Error('Invalid Signature')
    }

    // If the signature was verified successfully the _senderPubKey field is defined
    return this._senderPubKey!
  }

  /**
   * Determines if the signature is valid
   */
  verifySignature(): boolean {
    const msgHash = this.hash(false)
    // All transaction signatures whose s-value is greater than secp256k1n/2 are considered invalid.
    if (this._common.gteHardfork('homestead') && new BN(this.s).cmp(N_DIV_2) === 1) {
      return false
    }

    try {
      const v = bufferToInt(this.v)
      const useChainIdWhileRecoveringPubKey =
        v >= this._chainId * 2 + 35 && this._common.gteHardfork('spuriousDragon')
      this._senderPubKey = ecrecover(
        msgHash,
        v,
        this.r,
        this.s,
        useChainIdWhileRecoveringPubKey ? this._chainId : undefined,
      )
    } catch (e) {
      return false
    }

    return !!this._senderPubKey
  }

  /**
   * sign a transaction with a given private key
   * @param privateKey - Must be 32 bytes in length
   */
  sign(privateKey: Buffer) {
    const msgHash = this.hash(false)
    const sig = ecsign(msgHash, privateKey)
    if (this._chainId > 0) {
      sig.v += this._chainId * 2 + 8
    }
    Object.assign(this, sig)
  }

  /**
   * The amount of gas paid for the data in this tx
   */
  getDataFee(): BN {
    const data = this.raw[5]
    const cost = new BN(0)
    for (let i = 0; i < data.length; i++) {
      data[i] === 0
        ? cost.iaddn(this._common.param('gasPrices', 'txDataZero'))
        : cost.iaddn(this._common.param('gasPrices', 'txDataNonZero'))
    }
    return cost
  }

  /**
   * the minimum amount of gas the tx must have (DataFee + TxFee + Creation Fee)
   */
  getBaseFee(): BN {
    const fee = this.getDataFee().iaddn(this._common.param('gasPrices', 'tx'))
    if (this._common.gteHardfork('homestead') && this.toCreationAddress()) {
      fee.iaddn(this._common.param('gasPrices', 'txCreation'))
    }
    return fee
  }

  /**
   * the up front amount that an account must have for this transaction to be valid
   */
  getUpfrontCost(): BN {
    return new BN(this.gasLimit).imul(new BN(this.gasPrice)).iadd(new BN(this.value))
  }

  /**
   * Validates the signature and checks to see if it has enough gas.
   */
  validate(): boolean
  validate(stringError: false): boolean
  validate(stringError: true): string
  validate(stringError: boolean = false): boolean | string {
    const errors = []
    if (!this.verifySignature()) {
      errors.push('Invalid Signature')
    }

    if (this.getBaseFee().cmp(new BN(this.gasLimit)) > 0) {
      errors.push([`gas limit is too low. Need at least ${this.getBaseFee()}`])
    }

    if (stringError === false) {
      return errors.length === 0
    } else {
      return errors.join(' ')
    }
  }

  /**
   * Returns the rlp encoding of the transaction
   */
  serialize(): Buffer {
    // Note: This never gets executed, defineProperties overwrites it.
    return rlp.encode(this.raw)
  }
}
