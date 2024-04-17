import {
  Fee,
  Msg,
  WaitTxBroadcastResult,
  Wallet
} from '@initia/initia.jsv41'

export async function sendTx(
  wallet: Wallet,
  msgs: Msg[],
  fee?: Fee,
  accountNumber?: number,
  sequence?: number,
  timeout = 10_000
): Promise<WaitTxBroadcastResult> {
  const signedTx = await wallet.createAndSignTx({
    msgs,
    fee,
    accountNumber,
    sequence
  })
  const broadcastResult = await wallet.lcd.tx.broadcast(signedTx, timeout)
  if (broadcastResult['code']) throw new Error(broadcastResult.raw_log)
  return broadcastResult
}
