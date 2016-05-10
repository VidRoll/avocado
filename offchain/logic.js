/*global Uint8Array*/

import request from 'request'
import leftPad from 'left-pad'
import promisify from 'es6-promisify'
import { Hex, Address, Bytes32 } from './types.js'
import t from 'tcomb'

const post = promisify(function (url, body, callback) {
  request.post({
    url,
    body,
    json: true,
  }, callback)
})

export class Logic {
  constructor({
    storage,
    channels,
    web3
  }) {
    this.storage = storage
    this.channels = channels
    this.web3 = web3
    this.solSha3 = solSha3.bind(this)
    this.verifyUpdate = verifyUpdate.bind(this)
    this.sign = promisify(this.web3.eth.sign)
  }
  
  
  
  // View proposed channels
  async viewProposedChannels () {
    return this.storage.getItem('proposedChannels')
  }
  
  
  
  // View one proposed channel
  async viewProposedChannel (channelId) {
    const proposedChannels = this.storage.getItem('proposedChannels')
    return proposedChannels[channelId]
  }
  
  
  
  // Propose a new channel and send to counterparty
  async proposeChannel (params) {
    const myAccount = t.maybe(t.Number)(params.myAccount)
    const myAddress = t.maybe(Address)(params.myAddress)
    const counterpartyAccount = t.maybe(t.Number)(params.counterpartyAccount)
    const counterpartyAddress = t.maybe(Address)(params.counterpartyAddress)
    const counterpartyUrl = t.String(params.counterpartyUrl)
    const channelId = Bytes32(params.channelId)
    const state = Hex(params.state)
    const challengePeriod = t.Number(params.challengePeriod)

    const address0 = myAddress || this.web3.eth.accounts[myAccount]
    const address1 = counterpartyAddress || this.web3.eth.accounts[counterpartyAccount]
    
    const fingerprint = this.solSha3(
      'newChannel',
      channelId,
      address0,
      address1,
      state,
      challengePeriod
    )

    this.storage.setItem('channels:' + channelId, {
      channelId,
      address0,
      address1,
      state,
      challengePeriod,
      theirProposedUpdates: [],
      myProposedUpdates: [],
      acceptedUpdates: []
    })

    const signature0 = await this.sign(address0, fingerprint)

    const res = await post(counterpartyUrl + '/add_proposed_channel', {
      channelId,
      address0,
      address1,
      state,
      challengePeriod,
      signature0
    })
    
    return res.body
  }



  // Called by the counterparty over the http api, gets added to the
  // proposed channel list
  async addProposedChannel (channel) {    
    this.verifyChannel(channel)

    let proposedChannels = this.storage.getItem('proposedChannels') || {}
    proposedChannels[channel.channelId] = channel
    this.storage.setItem('proposedChannels', proposedChannels)
  }



  // Get a channel from the proposed channel list and accept it
  async acceptProposedChannel (channelId) {
    await this.acceptChannel(
      this.storage.getItem('proposedChannels')[channelId]
    )
  }



  // Sign the opening tx and post it to the blockchain to open the channel
  async acceptChannel (channel) {
    const fingerprint = this.verifyChannel(channel)

    const signature1 = await this.sign(channel.address1, fingerprint)

    await this.channels.newChannel(
      channel.channelId,
      channel.address0,
      channel.address1,
      channel.state,
      channel.challengePeriod,
      channel.signature0,
      channel.signature1
    )
  }



  // Propose an update to a channel, sign, store, and send to counterparty
  async proposeUpdate (params) {
    const channelId = Bytes32(params.channelId)
    const state = Hex(params.state)
    
    const channels = this.storage.getItem('channels')
    const channel = channels[channelId]
    
    const sequenceNumber = highestProposedSequenceNumber(channel) + 1
    
    const fingerprint = this.solSha3(
      'updateState',
      channelId,
      sequenceNumber,
      state
    )
    
    const signature = await this.sign(
      channel['address' + channel.me],
      fingerprint
    )

    const update = {
      channelId,
      sequenceNumber,
      state,
      ['signature' + channel.me]: signature
    }

    channel.myProposedUpdates.push(update)
    this.storage.setItem('channels', channels)
    
    await post(channel.counterpartyUrl + '/add_proposed_update', update)
  }
  
  

  // Called by the counterparty over the http api, gets verified and
  // added to the proposed update list
  async addProposedUpdate (update) {
    const channel = this.storage.getItem('channels')[update.channelId]
    
    this.verifyUpdate({
      channel,
      update
    })
    
    if (update.sequenceNumber <= highestProposedSequenceNumber(channel)) {
      throw new Error('sequenceNumber too low')
    }
    
    channel.theirProposedUpdates.push(update)
    
    this.storageChannel(channel)
  }

  

  // Sign the update and send it back to the counterparty
  async acceptUpdate (update) {
    const channel = this.storage.getItem('channels')[update.channelId]
    
    const fingerprint = this.verifyUpdate({
      channel,
      update
    })

    const signature = await this.sign(
      channel['address' + channel.me],
      fingerprint
    )

    update['signature' + channel.me] = signature
    
    channel.acceptedUpdates.push(update)
    
    this.storeChannel(channel)
    
    await post(channel.counterpartyUrl + '/add_accepted_update', update)
  }


  // Accepts last update from theirProposedUpdates 
  async acceptLastUpdate (channelId) {
    const channel = this.storage.getItem('channels')[channelId]
    const lastUpdate = channel.theirProposedUpdates[
      channel.theirProposedUpdates.length - 1
    ]
    
    this.acceptUpdate(lastUpdate)
  }
  


  // Called by the counterparty over the http api, gets verified and
  // added to the accepted update list
  async addAcceptedUpdate (update) {
    const channel = this.storage.getItem('channels')[update.channelId]
    
    this.verifyUpdate({
      channel,
      update,
      checkMySignature: true
    })

    if (update.sequenceNumber <= highestAcceptedSequenceNumber(channel)) {
      throw new Error('sequenceNumber too low')
    }
    
    channel.acceptedUpdates.push(update)
    
    this.storeChannel(channel)
  }



  // Post last accepted update to the blockchain
  async postLastUpdate (channelId) {
    Bytes32(channelId)
    
    const channels = this.storage.getItem('channels')
    const channel = channels[channelId]
    const update = channel.acceptedUpdates[channel.acceptedUpdates.length - 1]

    await this.channels.updateState(
      update.channelId,
      update.sequenceNumber,
      update.state,
      update.signature0,
      update.signature1
    )
  }



  // Start the challenge period, putting channel closing into motion
  async startChallengePeriod (channelId) {
    Bytes32(channelId)
    
    const channel = this.storage.getItem('channels' + channelId)
    const fingerprint = this.solSha3(
      'startChallengePeriod',
      channelId
    )
    
    const signature = await this.sign(
      channel['address' + channel.me],
      fingerprint
    )
    
    await this.channels.startChallengePeriod(
      channelId,
      signature
    )
  }



  // Gets the channels list, adds the channel, saves the channels list 
  storeChannel (channel) {
    const channels = this.storage.getItem('channels')
    channels[channel.channelId] = channel
    this.storage.setItem('channels', channels)
  }
}



// This checks that the signature is valid
async function verifyChannel(channel) {
  const channelId = Bytes32(channel.channelId)
  const address0 = Address(channel.address0)
  const address1 = Address(channel.address1)
  const state = Hex(channel.state)
  const challengePeriod = t.Number(channel.challengePeriod)
  const signature0 = Hex(channel.signature0)

  const fingerprint = this.solSha3(
    'newChannel',
    channelId,
    address0,
    address1,
    state,
    challengePeriod
  )

  const valid = await this.channels.ecverify.call(
    fingerprint,
    signature0,
    address0
  )

  if (!valid) {
    throw new Error('signature0 invalid')
  }
  
  return fingerprint
}



// This checks that their signature is valid, and optionally
// checks my signature as well
async function verifyUpdate ({channel, update, checkMySignature}) {
  const channelId = Bytes32(update.channelId)
  const state = Hex(update.state)
  const sequenceNumber = t.Number(update.challengePeriod)
  t.maybe(t.Boolean)(checkMySignature)
  
  const fingerprint = this.solSha3(
    'updateState',
    channelId,
    sequenceNumber,
    state
  )

  let valid = await this.channels.ecverify.call(
    fingerprint,
    update['signature' + swap[channel.me]],
    channel['address' + swap[channel.me]]
  )

  if (!valid) {
    throw new Error('signature' + swap[channel.me] + ' invalid')
  }

  if (checkMySignature) {
    let valid = await this.channels.ecverify.call(
      fingerprint,
      update['signature' + channel.me],
      channel['address' + channel.me]
    )

    if (!valid) {
      throw new Error('signature' + channel.me + ' invalid')
    }
  }

  return fingerprint
}

const swap = [1, 0]

function highestAcceptedSequenceNumber (channel) {
  return channel.acceptedUpdates[
    channel.acceptedUpdates.length - 1
  ].sequenceNumber
}

function highestProposedSequenceNumber (channel) {
  const myHighestSequenceNumber = channel.myProposedUpdates[
    channel.myProposedUpdates.length - 1
  ].sequenceNumber
  
  const theirHighestSequenceNumber = channel.myProposedUpdates[
    channel.myProposedUpdates.length - 1
  ].sequenceNumber
  
  return Math.max(
    myHighestSequenceNumber,
    theirHighestSequenceNumber
  )
}

function solSha3 (...args) {
  args = args.map(arg => {
    if (typeof arg === 'string') {
      if (arg.substring(0, 2) === '0x') {
        return arg.slice(2)
      } else {
        return this.web3.toHex(arg).slice(2)
      }
    }

    if (typeof arg === 'number') {
      return leftPad((arg).toString(16), 64, 0)
    }
    
    else {
      return ''
    }
  })

  args = args.join('')

  return '0x' + this.web3.sha3(args, { encoding: 'hex' })
}