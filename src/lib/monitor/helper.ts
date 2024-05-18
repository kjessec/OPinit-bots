import { BlockInfo, LCDClient, TxSearchOptions, TxSearchResult } from 'initia-l2'
import { getLatestOutputFromExecutor, getOutputFromExecutor } from '../query'
import { WithdrawStorage } from '../storage'
import { WithdrawalTx } from '../types'
import { sha3_256 } from '../util'
import OutputEntity from '../../orm/executor/OutputEntity'
import { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm'

class MonitorHelper {
  ///
  /// DB
  ///

  public async getSyncedState<T extends ObjectLiteral>(
    manager: EntityManager,
    entityClass: EntityTarget<T>,
    name: string
  ): Promise<T | null> {
    return await manager.getRepository(entityClass).findOne({
      where: { name: name } as any
    })
  }

  public async getWithdrawalTxs<T extends ObjectLiteral>(
    manager: EntityManager,
    entityClass: EntityTarget<T>,
    outputIndex: number
  ): Promise<T[]> {
    return await manager.getRepository(entityClass).find({
      where: { outputIndex } as any
    })
  }

  async getDepositTx<T extends ObjectLiteral>(
    manager: EntityManager,
    entityClass: EntityTarget<T>,
    sequence: number,
    metadata: string
  ): Promise<T | null> {
    return await manager.getRepository(entityClass).findOne({
      where: { sequence, metadata } as any
    })
  }

  public async getCoin<T extends ObjectLiteral>(
    manager: EntityManager,
    entityClass: EntityTarget<T>,
    metadata: string
  ): Promise<T | null> {
    return await manager.getRepository(entityClass).findOne({
      where: { l2Metadata: metadata } as any
    })
  }

  public async getLastOutputFromDB<T extends ObjectLiteral>(
    manager: EntityManager,
    entityClass: EntityTarget<T>
  ): Promise<T | null> {
    const lastOutput = await manager.getRepository<T>(entityClass).find({
      order: { outputIndex: 'DESC' } as any,
      take: 1
    })
    return lastOutput[0] ?? null
  }

  public async getLastOutputIndex<T extends ObjectLiteral>(
    manager: EntityManager,
    entityClass: EntityTarget<T>
  ): Promise<number> {
    const lastOutput = await this.getLastOutputFromDB(manager, entityClass)
    const lastIndex = lastOutput ? lastOutput.outputIndex : 0
    return lastIndex
  }

  public async getOutputByIndex<T extends ObjectLiteral>(
    manager: EntityManager,
    entityClass: EntityTarget<T>,
    outputIndex: number
  ): Promise<T | null> {
    return await manager.getRepository<T>(entityClass).findOne({
      where: { outputIndex } as any
    })
  }

  public async saveEntity<T extends ObjectLiteral>(
    manager: EntityManager,
    entityClass: EntityTarget<T>,
    entity: T
  ): Promise<T> {
    return await manager.getRepository(entityClass).save(entity)
  }

  ///
  ///  UTIL
  ///

  public extractErrorMessage(error: any): string {
    return error.response?.data
      ? JSON.stringify(error.response.data)
      : error.toString()
  }

  public async fetchAllEvents(
    lcd: any,
    height: number
  ): Promise<[boolean, any[]]> {
    const searchRes = await this.search(lcd, {
      query: [{ key: 'tx.height', value: height.toString() }]
    })

    const extractAllEvents = (txs: any[]) =>
      txs
        .filter((tx) => tx.events && tx.events.length > 0)
        .flatMap((tx) => tx.events ?? [])
    const isEmpty = searchRes.txs.length === 0
    const events = extractAllEvents(searchRes.tx_responses)

    return [isEmpty, events]
  }

  public eventsToAttrMap(event: any): { [key: string]: string } {
    return event.attributes.reduce((obj, attr) => {
      obj[attr.key] = attr.value
      return obj
    }, {})
  }

  public parseData(attrMap: { [key: string]: string }): {
    [key: string]: string;
  } {
    return JSON.parse(attrMap['data'])
  }

  // search tx without from data
  public async search(
    lcd: LCDClient,
    options: Partial<TxSearchOptions>
  ): Promise<TxSearchResult.Data> {
    const params = new URLSearchParams()

    // build search params
    options.query?.forEach(v =>
      params.append(
        'query',
        v.key === 'tx.height' ? `${v.key}=${v.value}` : `${v.key}='${v.value}'`
      )
    )

    delete options['query']

    Object.entries(options).forEach(v => {
      params.append(v[0], v[1] as string)
    })

    return lcd.apiRequester.getRaw<TxSearchResult.Data>(`/cosmos/tx/v1beta1/txs`, params)
  }

  ///
  /// L1 HELPER
  ///

  ///
  /// L2 HELPER
  ///

  public calculateOutputEntity(
    outputIndex: number,
    blockInfo: BlockInfo,
    merkleRoot: string,
    startBlockNumber: number,
    endBlockNumber: number
  ): OutputEntity {
    const version = outputIndex
    const stateRoot = blockInfo.block.header.app_hash
    const lastBlockHash = blockInfo.block_id.hash
    const outputRoot = sha3_256(
      Buffer.concat([
        sha3_256(version),
        Buffer.from(stateRoot, 'base64'),
        Buffer.from(merkleRoot, 'base64'),
        Buffer.from(lastBlockHash, 'base64')
      ])
    ).toString('base64')

    const outputEntity = {
      outputIndex,
      outputRoot,
      stateRoot,
      merkleRoot,
      lastBlockHash,
      startBlockNumber,
      endBlockNumber
    }

    return outputEntity
  }

  async saveMerkleRootAndProof<T extends ObjectLiteral>(
    manager: EntityManager,
    entityClass: EntityTarget<T>,
    entities: any[] // ChallengerWithdrawalTxEntity[] or ExecutorWithdrawalTxEntity[]
  ): Promise<string> {
    const txs: WithdrawalTx[] = entities.map((entity) => ({
      bridge_id: BigInt(entity.bridgeId),
      sequence: BigInt(entity.sequence),
      sender: entity.sender,
      receiver: entity.receiver,
      l1_denom: entity.l1Denom,
      amount: BigInt(entity.amount)
    }))

    const storage = new WithdrawStorage(txs)
    const merkleRoot = storage.getMerkleRoot()
    for (let i = 0; i < entities.length; i++) {
      entities[i].merkleRoot = merkleRoot
      entities[i].merkleProof = storage.getMerkleProof(txs[i])
      await this.saveEntity(manager, entityClass, entities[i])
    }
    return merkleRoot
  }

  public async getLatestOutputFromExecutor() {
    const outputRes = await getLatestOutputFromExecutor()
    if (!outputRes.output) {
      throw new Error('No output from executor')
    }
    return outputRes.output
  }

  public async getOutputFromExecutor(outputIndex: number) {
    const outputRes = await getOutputFromExecutor(outputIndex)
    if (!outputRes.output) {
      throw new Error('No output from executor')
    }
    return outputRes.output
  }
}

export default MonitorHelper
