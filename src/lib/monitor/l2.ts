import { ExecutorOutputEntity, ExecutorWithdrawalTxEntity } from '../../orm'
import { Monitor } from './monitor'
import { EntityManager } from 'typeorm'
import { BlockInfo } from 'initia-l2'
import { getDB } from '../../worker/bridgeExecutor/db'
import { RPCClient, RPCSocket } from '../rpc'
import winston from 'winston'
import { config } from '../../config'
import { getBridgeInfo, getLastOutputInfo } from '../query'
import { TxWalletL2, WalletType, getWallet, initWallet } from '../walletL2'
import { MetricName, Prometheus } from '../../lib/metrics'

export class L2Monitor extends Monitor {
  executorL2: TxWalletL2

  constructor(
    public socket: RPCSocket,
    public rpcClient: RPCClient,
    logger: winston.Logger
  ) {
    super(socket, rpcClient, logger);
    [this.db] = getDB()
    initWallet(WalletType.Executor, config.l2lcd)
    this.executorL2 = getWallet(WalletType.Executor)
  }

  async getLatestBlock(): Promise<BlockInfo> {
    return await this.executorL2.lcd.tendermint.blockInfo()
  }

  public name(): string {
    return 'executor_l2_monitor'
  }

  dateToSeconds(date: Date): number {
    return Math.floor(date.getTime() / 1000)
  }

  private getCurTimeSec(): number {
    return this.dateToSeconds(new Date())
  }

  public async endBlock(): Promise<void> {
    Prometheus.add({
      name: MetricName.L2MonitorHeight,
      data: this.currentHeight
    })
  }

  private async handleInitiateTokenWithdrawalEvent(
    manager: EntityManager,
    data: { [key: string]: string }
  ): Promise<void> {
    const outputInfo = await this.helper.getLastOutputFromDB(
      manager,
      ExecutorOutputEntity
    )

    if (!outputInfo) {
      this.logger.info(
        `[handleInitiateTokenWithdrawalEvent - ${this.name()}] No output info`
      )
      return
    }
    const pair = await config.l1lcd.ophost.tokenPairByL2Denom(
      this.bridgeId,
      data['denom']
    )

    const tx: ExecutorWithdrawalTxEntity = {
      l1Denom: pair.l1_denom,
      l2Denom: pair.l2_denom,
      sequence: data['l2_sequence'],
      sender: data['from'],
      receiver: data['to'],
      amount: data['amount'],
      bridgeId: this.bridgeId.toString(),
      outputIndex: outputInfo ? outputInfo.outputIndex + 1 : 1,
      merkleRoot: '',
      merkleProof: []
    }

    await this.helper.saveEntity(manager, ExecutorWithdrawalTxEntity, tx)
    this.logger.info(
      `[handleInitiateTokenWithdrawalEvent - ${this.name()}] Succeeded to save withdrawal tx`
    )
  }

  public async handleEvents(manager: EntityManager): Promise<boolean> {
    const [isEmpty, events] = await this.helper.fetchAllEvents(
      config.l2lcd,
      this.currentHeight
    )
    if (isEmpty) {
      this.logger.info(
        `[handleEvents - ${this.name()}] No events in height: ${this.currentHeight}`
      )
      return false
    }

    const withdrawalEvents = events.filter(
      (evt) => evt.type === 'initiate_token_withdrawal'
    )
    for (const evt of withdrawalEvents) {
      const attrMap = this.helper.eventsToAttrMap(evt)
      await this.handleInitiateTokenWithdrawalEvent(manager, attrMap)
    }

    return true
  }

  async checkSubmissionInterval(): Promise<boolean> {
    const lastOutputSubmitted = await getLastOutputInfo(this.bridgeId)
    if (lastOutputSubmitted) {
      const lastOutputSubmittedTime =
        lastOutputSubmitted.output_proposal.l1_block_time
      const bridgeInfo = await getBridgeInfo(this.bridgeId)
      const submissionInterval =
        bridgeInfo.bridge_config.submission_interval.seconds.toNumber()
      if (
        this.getCurTimeSec() <
        this.dateToSeconds(lastOutputSubmittedTime) +
          Math.floor(submissionInterval * config.SUBMISSION_THRESHOLD)
      )
        return false
    }
    return true
  }

  async handleOutput(manager: EntityManager): Promise<void> {
    if (!(await this.checkSubmissionInterval())) {
      this.logger.info(
        `[handleOutput - ${this.name()}] Submission interval not reached`
      )
      return
    }

    const lastOutput = await this.helper.getLastOutputFromDB(
      manager,
      ExecutorOutputEntity
    )

    const lastOutputEndBlockNumber = lastOutput ? lastOutput.endBlockNumber : 0
    const lastOutputIndex = lastOutput ? lastOutput.outputIndex : 0

    const startBlockNumber = lastOutputEndBlockNumber + 1
    const endBlockNumber = this.currentHeight
    const outputIndex = lastOutputIndex + 1

    if (startBlockNumber > endBlockNumber) {
      this.logger.info(
        `[handleOutput - ${this.name()}] No new block to process`
      )
      return
    }

    const blockInfo: BlockInfo = await config.l2lcd.tendermint.blockInfo(
      this.currentHeight
    )

    // fetch txs and build merkle tree for withdrawal storage
    const txEntities = await this.helper.getWithdrawalTxs(
      manager,
      ExecutorWithdrawalTxEntity,
      outputIndex
    )

    const merkleRoot = await this.helper.saveMerkleRootAndProof(
      manager,
      ExecutorWithdrawalTxEntity,
      txEntities
    )

    const outputEntity = this.helper.calculateOutputEntity(
      outputIndex,
      blockInfo,
      merkleRoot,
      startBlockNumber,
      endBlockNumber
    )

    await this.helper.saveEntity(manager, ExecutorOutputEntity, outputEntity)
  }

  public async handleBlock(manager: EntityManager): Promise<void> {
    await this.handleOutput(manager)
  }
}
