/* global assert, artifacts */
const { BN, ether, time } = require('openzeppelin-test-helpers')

const {
  silent,
  gasLogWrapper,
  log,
  toEth,
  timestamp,
  varLogger
} = require('./utils')

// I know, it's gross
// add wei converter
/* eslint no-extend-native: 0 */
Number.prototype.toWei = function toWei () {
  return ether(this.toString())
}
Number.prototype.toBN = function toBN () {
  return new BN(this.toString(), 10)
}

const MaxRoundingError = 100

const contractNames = [
  'DutchExchangeProxy',
  'DutchExchangeHelper',
  'EtherToken',
  'OWLAirdrop',
  'TokenGNO',
  'TokenOWLProxy',
  'TokenFRT',
  'TokenFRTProxy',
  'PriceOracleInterface',
  'PriceFeed',
  'Medianizer'
]
// DutchExchange and TokenOWL are added after their respective Proxy contracts are deployed

let contractsCache

/**
 * getContracts - async loads contracts and instances
 *
 * @returns { Mapping(contractName => deployedContract) }
 */
const getContracts = async ({ resetCache } = {}) => {
  if (!contractsCache || resetCache) {
    const depContracts = contractNames.map(c => artifacts.require(c)).map(cc => cc.deployed())
    const contractInstances = await Promise.all(depContracts)

    const gasLoggedContracts = gasLogWrapper(contractInstances)

    const deployedContracts = contractNames.reduce((acc, name, i) => {
      acc[name] = gasLoggedContracts[i]
      return acc
    }, {})
    const proxiedContracts = await Promise.all([
      artifacts.require('DutchExchange').at(deployedContracts.DutchExchangeProxy.address),
      artifacts.require('TokenOWL').at(deployedContracts.TokenOWLProxy.address),
      artifacts.require('TokenFRT').at(deployedContracts.TokenFRTProxy.address)
    ]);

    [deployedContracts.DutchExchange, deployedContracts.TokenOWL, deployedContracts.TokenFRT] = gasLogWrapper(proxiedContracts)

    contractsCache = deployedContracts
  }
  return contractsCache
}

/**
 * getBalance of Acct and Tokens
 * @param {address} acct
 * @param {address} token
 */
const getBalance = async (acct, token) => {
  const { DutchExchange: dx } = await getContracts()
  return dx.balances.call(token.address, acct)
}

const getAuctionStart = async (ST, BT) => {
  const { DutchExchange: dx } = await getContracts()
  return (await dx.getAuctionStart.call(ST.address, BT.address)).toNumber()
}

/**
 * >setupTest()
 * @param {Array[address]} accounts         => ganache-cli accounts passed in globally
 * @param {Object}         contract         => Contract object obtained via: const contract = await getContracts() (see above)
 * @param {Object}         number Amounts   => { ethAmount = amt to deposit and approve, gnoAmount = for gno, ethUSDPrice = eth price in USD }
 */
const setupTest = async (
  accounts,
  {
    DutchExchange: dx,
    EtherToken: eth,
    TokenGNO: gno,
    PriceFeed: oracle,
    Medianizer: medianizer
  },
  {
    startingETH = 50.0.toWei(),
    startingGNO = 50.0.toWei(),
    ethUSDPrice = 1100.0.toWei()
  }) => {
  // Await ALL Promises for each account setup

  await Promise.all(accounts.map(acct => {
    /* eslint array-callback-return:0 */
    if (acct === accounts[0]) return
    eth.deposit({ from: acct, value: startingETH })
    eth.approve(dx.address, startingETH, { from: acct })
    gno.transfer(acct, startingGNO, { from: accounts[0] })
    gno.approve(dx.address, startingGNO, { from: acct })
  }))
  // Deposit depends on ABOVE finishing first... so run here
  await Promise.all(accounts.map(acct => {
    if (acct === accounts[0]) return
    dx.deposit(eth.address, startingETH, { from: acct })
    dx.deposit(gno.address, startingGNO, { from: acct })
  }))

  // add token Pair
  // updating the oracle Price. Needs to be changed later to another mechanism
  await oracle.post(ethUSDPrice, 1516168838 * 2, medianizer.address, { from: accounts[0] })

  // const gnoAcctBalances = await Promise.all(accounts.map(accts => getBalance(accts, gno)))
  // const ethAcctBalances = await Promise.all(accounts.map(accts => getBalance(accts, eth)))

  // gnoAcctBalances.slice(1).forEach(bal => assert.equal(bal, startingGNO))
  // ethAcctBalances.slice(1).forEach(bal => assert.equal(bal, startingETH))
}

// testing Auction Functions
/**
 * setAndCheckAuctionStarted - gets Auction Idx for curr Token Pair and moves time to auction start if: start = false
 * @param {address} ST - Sell Token
 * @param {address} BT - Buy Token
 */
const setAndCheckAuctionStarted = async (ST, BT) => {
  const { DutchExchange: dx, EtherToken: eth, TokenGNO: gno } = await getContracts()
  ST = ST || eth; BT = BT || gno

  const startingTimeOfAuction = (await dx.getAuctionStart.call(ST.address, BT.address)).toNumber()
  assert.equal(startingTimeOfAuction > 1, true, 'Auction hasn`t started yet')

  // wait for the right time to send buyOrder
  // implements isAtLeastZero (aka will not go BACK in time)
  await time.increase(startingTimeOfAuction - await timestamp())

  const now = await timestamp()
  log(`
  time now ----------> ${new Date(now * 1000)}
  auction starts ----> ${new Date(startingTimeOfAuction * 1000)}
  `)

  assert.equal(now >= startingTimeOfAuction, true)
}

/**
 * waitUntilPriceIsXPercentOfPreviousPrice
 * @param {address} ST  => Sell Token
 * @param {address} BT  => Buy Token
 * @param {unit}    p   => percentage of the previous price
 */
const waitUntilPriceIsXPercentOfPreviousPrice = async (ST, BT, p) => {
  const { DutchExchange: dx } = await getContracts()

  let currentIndex, priceBefore, currentAuctionPrice
  if (!silent) {
    currentIndex = await dx.getAuctionIndex.call(ST.address, BT.address)
    currentAuctionPrice = await dx.getCurrentAuctionPrice.call(ST.address, BT.address, currentIndex)
    let { num, den } = currentAuctionPrice
    priceBefore = num / den
    log(`
      Price BEFORE waiting until Price = initial Closing Price (2) * 2
      ==============================
      Price.num             = ${num}
      Price.den             = ${den}
      Price at this moment  = ${(priceBefore)}
      ==============================
    `)
  }

  const startingTimeOfAuction = (await dx.getAuctionStart.call(ST.address, BT.address)).toNumber()
  const timeToWaitFor = Math.ceil((86400 - p * 43200) / (1 + p)) + startingTimeOfAuction
  // wait until the price is good
  await time.increase(timeToWaitFor - await timestamp())

  if (!silent) {
    currentAuctionPrice = await dx.getCurrentAuctionPrice.call(ST.address, BT.address, currentIndex)
    num = currentAuctionPrice.num
    den = currentAuctionPrice.den
    const priceAfter = num / den
    log(`
      Price AFTER waiting until Price = ${p * 100}% of ${priceBefore / 2} (initial Closing Price)
      ==============================
      Price.num             = ${num}
      Price.den             = ${den}
      Price at this moment  = ${(priceAfter)}
      ==============================
    `)
  }
  assert.equal(await timestamp() >= timeToWaitFor, true)
  // assert.isAtLeast(priceAfter, (priceBefore / 2) * p)

  return timeToWaitFor
}

/**
 * checkBalanceBeforeClaim
 * @param {string} acct       => acct to check Balance of
 * @param {number} idx        => auctionIndex to check
 * @param {string} claiming   => 'seller' || 'buyer'
 * @param {address} ST        => Sell Token
 * @param {address} BT        => Buy Token
 * @param {number} amt        => amt to check
 * @param {number} round      => rounding error threshold
 */
const checkBalanceBeforeClaim = async (
  acct,
  idx,
  claiming,
  ST,
  BT,
  amt = (10 ** 9),
  round = (MaxRoundingError)
) => {
  const { DutchExchange: dx, EtherToken: eth, TokenGNO: gno } = await getContracts()
  ST = ST || eth; BT = BT || gno

  let token = ST
  if (claiming === 'seller') {
    token = BT
  }

  const balanceBeforeClaim = await dx.balances.call(token.address, acct)

  if (claiming === 'buyer') {
    await dx.claimBuyerFunds(ST.address, BT.address, acct, idx)
  } else {
    await dx.claimSellerFunds(ST.address, BT.address, acct, idx)
  }

  const balanceAfterClaim = await dx.balances.call(token.address, acct)
  const difference = balanceBeforeClaim.add(amt).sub(balanceAfterClaim).abs()
  varLogger('claiming for', claiming)
  varLogger('balanceBeforeClaim', balanceBeforeClaim.toString())
  varLogger('amount', amt.toString())
  varLogger('balanceAfterClaim', balanceAfterClaim.toString())
  varLogger('difference', difference.toString())
  assert.equal(difference.toNumber() < round, true)
}

/**
 * getAuctionIndex
 * @param {addr} Sell Token
 * @param {addr} Buy Token
 */
const getAuctionIndex = async (sell, buy) => {
  const { DutchExchange: dx, EtherToken: eth, TokenGNO: gno } = await getContracts()
  sell = sell || eth; buy = buy || gno

  return (await dx.getAuctionIndex.call(buy.address, sell.address)).toNumber()
}

// const getStartingTimeOfAuction = async (sell = eth, buy = gno) => (await dx.getAuctionStart.call(sell.address, buy.address)).toNumber()

/**
 * postBuyOrder
 * @param {address} ST      => Sell Token
 * @param {address} BT      => Buy Token
 * @param {uint}    aucIdx  => auctionIndex
 * @param {uint}    amt     => amount
 *
 * @returns { tx receipt }
 */
const postBuyOrder = async (ST, BT, aucIdx, amt, acct) => {
  const { DutchExchange: dx, EtherToken: eth, TokenGNO: gno } = await getContracts()
  ST = ST || eth; BT = BT || gno
  let auctionIdx = aucIdx || await getAuctionIndex(ST, BT)

  if (!silent) {
    log(`
    Current Auction Index -> ${auctionIdx}
    `)
    const buyVolumes = await dx.buyVolumes.call(ST.address, BT.address)
    const sellVolumes = await dx.sellVolumesCurrent.call(ST.address, BT.address)
    log(`
      Current Buy Volume BEFORE Posting => ${toEth(buyVolumes)}
      Current Sell Volume               => ${toEth(sellVolumes)}
      ----
      Posting Buy Amt -------------------> ${toEth(amt)} in ${await ST.symbol()} for ${await BT.symbol()} in auction ${auctionIdx}
    `)
  }
  // log('POSTBUYORDER TX RECEIPT ==', await dx.postBuyOrder(ST.address, BT.address, auctionIdx, amt, { from: acct }))
  return dx.postBuyOrder(ST.address, BT.address, auctionIdx, amt, { from: acct })
}

/**
 * postSellOrder
 * @param {address} ST      => Sell Token
 * @param {address} BT      => Buy Token
 * @param {uint}    aucIdx  => auctionIndex
 * @param {uint}    amt     => amount
 *
 * @returns { tx receipt }
 */
const postSellOrder = async (ST, BT, aucIdx, amt, acct) => {
  const { DutchExchange: dx, EtherToken: eth, TokenGNO: gno } = await getContracts()
  ST = ST || eth; BT = BT || gno
  let auctionIdx = aucIdx || 0

  if (!silent) {
    const buyVolumes = (await dx.buyVolumes.call(ST.address, BT.address))
    const sellVolumes = (await dx.sellVolumesCurrent.call(ST.address, BT.address))
    log(`
      Current Buy Volume BEFORE Posting => ${toEth(buyVolumes)}
      Current Sell Volume               => ${toEth(sellVolumes)}
      ----
      Posting Sell Amt -------------------> ${toEth(amt)} in ${await ST.symbol()} for ${await BT.symbol()} in auction ${auctionIdx}
    `)
  }
  // log('POSTBUYORDER TX RECEIPT ==', await dx.postBuyOrder(ST.address, BT.address, auctionIdx, amt, { from: acct }))
  // console.log({ st: ST.address, bt: BT.address, auctionIdx, amt, from: acct })
  return dx.postSellOrder(ST.address, BT.address, auctionIdx, amt, { from: acct })
}

/**
 * claimBuyerFunds
 * @param {address} ST      => Sell Token
 * @param {address} BT      => Buy Token
 * @param {address} user    => user address
 * @param {uint}    aucIdx  => auction Index [@default => getAuctionindex()]
 * @param {address} acct    => signer of tx if diff from user [@default = user]
 *
 * @returns { [uint returned, uint tulipsToIssue] }
 */
const claimBuyerFunds = async (ST, BT, user, aucIdx, acct) => {
  const { DutchExchange: dx, EtherToken: eth, TokenGNO: gno } = await getContracts()
  ST = ST || eth; BT = BT || gno; user = user || acct
  let auctionIdx = aucIdx || await getAuctionIndex(ST, BT)
  log('AUC IDX = ', auctionIdx)
  return dx.claimBuyerFunds(ST.address, BT.address, user, auctionIdx, { from: user })
}

/**
 * claimSellerFunds
 * @param {address} ST      => Sell Token
 * @param {address} BT      => Buy Token
 * @param {address} user    => user address
 * @param {uint}    aucIdx  => auction Index [@default => getAuctionindex()]
 * @param {address} acct    => signer of tx if diff from user [@default = user]
 *
 * @returns { [uint returned, uint tulipsToIssue] }
 */
const claimSellerFunds = async (ST, BT, user, aucIdx, acct) => {
  const { DutchExchange: dx, EtherToken: eth, TokenGNO: gno } = await getContracts()
  ST = ST || eth; BT = BT || gno; user = user || acct
  let auctionIdx = aucIdx || await getAuctionIndex(ST, BT)
  log('AUC IDX = ', auctionIdx)
  const { returned, frtsIssued } = await dx.claimSellerFunds.call(ST.address, BT.address, user, auctionIdx)
  log(`
  RETURNED    ===> ${toEth(returned)}
  MGN ISSUED  ===> ${toEth(frtsIssued)}
  `)
  return dx.claimSellerFunds(ST.address, BT.address, user, auctionIdx, { from: user })
}

/**
   * assertClaimingFundsCreatesMGNs
   * @param {address} ST    ==>   Sell Token
   * @param {address} BT    ==>   Buy Token
   * @param {address} acc   ==>   Account
   * @param {string}  type  ==>   Type of Account
   */
const assertClaimingFundsCreatesMGNs = async (ST, BT, acc, type) => {
  const {
    DutchExchange: dx, TokenFRT: tokenMGN
  } = await getContracts()

  if (!ST || !BT) throw new Error('No tokens passed in')

  let mgnsIssued
  // NOTE: MGNs are NOT minted/issued/etc until Auction has CLEARED
  const auctionIdx = await getAuctionIndex(ST, BT)
  assert.isAtLeast(auctionIdx, 2, 'Auction needs to have cleared - throw otherwise')

  // grab prevTulBalance to compare against new MGNs Issued later
  const prevTulBal = await tokenMGN.lockedTokenBalances.call(acc)

  if (type === 'seller') {
    const { frtsIssued: frtsAsSeller } = await dx.claimSellerFunds.call(ST.address, BT.address, acc, auctionIdx - 1)
    await claimSellerFunds(ST, BT, acc, auctionIdx - 1)
    mgnsIssued = frtsAsSeller
  } else {
    const { frtsIssued: frtsAsBuyer } = await dx.claimBuyerFunds.call(ST.address, BT.address, acc, auctionIdx - 1)
    await claimBuyerFunds(ST, BT, acc, auctionIdx - 1)
    mgnsIssued = frtsAsBuyer
  }

  const newMgnBal = await tokenMGN.lockedTokenBalances.call(acc)
  log(`
    LockedMgnBal === ${toEth(newMgnBal)}
    prevMgn + mgnIssued = newMgnBal
    ${toEth(prevTulBal)} + ${toEth(mgnsIssued)} = ${toEth(newMgnBal)}
    `)

  assert.equal(newMgnBal.toString(), prevTulBal.add(mgnsIssued).toString())
}

/**
   * checkUserReceivesTulipTokens (deprec)
   * @param {address} ST                => Sell Token: token using to buy buyToken (normally ETH)
   * @param {address} BT                => Buy Token: token to buy
   * @param {address} user              => address of current user buying and owning tulips
   * @param {uint}    lastsClosingPrice => lastClosingPrice of Token Pair
   */
const checkUserReceivesTulipTokens = async (ST, BT, user, idx, lastClosingPrice) => {
  const {
    DutchExchange: dx, EtherToken: eth, TokenGNO: gno, TokenFRT: tokenMGN
  } = await getContracts()
  ST = ST || eth; BT = BT || gno
  const aucIdx = idx || await getAuctionIndex(ST, BT)

  const BTName = await BT.name.call()
  const STName = await ST.name.call()

  // S1: grab returned an tulips amount BEFORE actually calling
  const [returned, tulips] = (await dx.claimBuyerFunds.call(ST.address, BT.address, user, aucIdx)).map(amt => amt.toNumber())
  let amtClaimed = (await dx.claimedAmounts.call(ST.address, BT.address, aucIdx, user)).toNumber()
  log(`
    ${STName}/${BTName}
    RETURNED          = ${returned.toEth()}           <-- Current amt returned in this fn call
    AMOUNT(S) CLAIMED = ${amtClaimed.toEth()}         < -- THIS + RETURNED = TULIPS

    TULIPS            = ${tulips.toEth()}             <-- Accumulation of returned + claimedAmounts
  `)
  let newBalance = (await dx.balances.call(ST.address, user)).toNumber()
  log(`
    USER'S ${STName} AMT = ${newBalance.toEth()}
  `)
  /*
   * SUB TEST 3: CLAIMBUYERFUNDS - CHECK BUYVOLUMES - CHECK LOCKEDTULIPS AMT = 1:1 FROM AMT IN POSTBUYORDER
   */
  const lockedTulFunds = (await tokenMGN.lockedTokenBalances.call(user)).toNumber()
  const calcAucIdx = await getAuctionIndex(ST, BT)

  log(`CalcAucIdx == ${calcAucIdx}`)

  if (calcAucIdx === 1) {
    assert.equal(tulips, 0, 'Auction is still running MGNs calculated still 0')
    // with changes, TULIPS are NOT minted until auctionCleared
    // lockedTulFunds should = 0
    assert.equal(lockedTulFunds, 0, 'for auctions that have NOT cleared there are 0 tulips')
    return
  }

  // S2: Actually claimBuyerFunds
  const { receipt: { logs } } = await claimBuyerFunds(ST, BT, user, aucIdx)
  log(logs ? '\tCLAIMING FUNDS SUCCESSFUL' : 'CLAIM FUNDS FAILED')
  // amtClaimed = (await dx.claimedAmounts.call(ST.address, BT.address, aucIdx, user)).toNumber()
  // Problem w/consts below is that if the auction has NOT cleared they will always be 0
  const tulFunds = (await tokenMGN.balanceOf.call(user)).toNumber()
  const lastestLockedTulFunds = (await tokenMGN.lockedTokenBalances.call(user)).toNumber()
  newBalance = (await dx.balances.call(ST.address, user)).toNumber()
  log(`
    USER'S OWNED TUL AMT      = ${tulFunds.toEth()}
    USER'S LOCKED TUL AMT     = ${lockedTulFunds.toEth()}
    USER'S LAST CLOSING PRICE = ${lastClosingPrice}
    USER'S ETH AMT            = ${newBalance.toEth()}
  `)

  if (STName === 'Ether Token' || BTName === 'Ether Token') {
    assert.isAtLeast(tulips.toEth(), (returned).toEth(), 'Auction closed returned tokens should equal tulips minted')
  } else {
    log(`
    TULIPS for NON-ETH trade == ${((returned * lastClosingPrice)).toEth()}
    `)
    assert.equal(tulips.toEth(), ((returned * lastClosingPrice)).toEth())
  }
  log(`
  CLAIMED AMTS === ${amtClaimed.toEth()}
  Locked TUL BEFORE CLAIM == ${lockedTulFunds.toEth()}
  Locked TUL AFTER CLAIM == ${lastestLockedTulFunds.toEth()}
  `)
  assert.equal((tulips + lockedTulFunds).toEth(), (lastestLockedTulFunds).toEth(), 'for any Token pair, auction has cleared so returned tokens should equal tulips minted')
}

/**
 * assertReturnedPlusMGNs
 * @param {addr} Sell Token
 * @param {addr} Buy Token
 * @param {addr} Account
 * @param {strg} Type of user >--> seller || buyer
 * @param {numb} Auction Index
 */
const assertReturnedPlusMGNs = async (ST, BT, acc, type, idx = 1, eth) => {
  let claimedAmount, mgnsIssued, userBalances
  const [
    { DutchExchange: dx },
    STName,
    BTName
  ] = await Promise.all([
    getContracts(),
    ST.name.call(),
    BT.name.call()
  ])

  // check if current trade is an ETH:ERC20 trade or not
  const nonETH = STName !== 'Ether Token' && BTName !== 'Ether Token'

  // calc closingPrices for both ETH/ERC20 and nonETH trades
  const { num, den } = await dx.closingPrices.call(ST.address, BT.address, idx)
  const { num: hNum, den: hDen } = await dx.getPriceInPastAuction.call(type === 'seller' ? ST.address : BT.address, eth.address, idx - 1)

  // conditionally check sellerBalances and returned/tulipIssued
  if (type === 'seller') {
    userBalances = await dx.sellerBalances.call(ST.address, BT.address, idx, acc)
    const { returned, frtsIssued } = await dx.claimSellerFunds.call(ST.address, BT.address, acc, idx)
    claimedAmount = returned
    mgnsIssued = frtsIssued
  } else {
    userBalances = await dx.buyerBalances.call(ST.address, BT.address, idx, acc)
    const { returned, frtsIssued } = await dx.claimBuyerFunds.call(ST.address, BT.address, acc, idx)
    claimedAmount = returned
    mgnsIssued = frtsIssued
  }

  log(`
  ${type === 'seller' ? '==SELLER==' : '==BUYER== '}
  [${STName}]//[${BTName}]
  ${type === 'seller' ? 'sellerBalance' : 'buyerBalance '}      == ${toEth(userBalances)}
  lastClosingPrice    == ${type === 'seller' ? (num / den) : (den / num)}
  lastHistoricalPrice == ${hNum / hDen}
  PriceToUse          == ${type === 'seller' && !nonETH ? (num / den) : type === 'seller' && nonETH ? (hNum / hDen) : type === 'buyer' && !nonETH ? (den / num) : (hNum / hDen)}
  RETURNED tokens     == ${toEth(claimedAmount)}
  MGN tokens        == ${toEth(mgnsIssued)}
  `)

  // ASSERTIONS
  // Seller
  if (type === 'seller') {
    if (!nonETH) {
      if (STName === 'Ether Token') {
        assert.equal(mgnsIssued.toString(), userBalances.toString())
      } else {
        assert.equal(mgnsIssued.toString(), claimedAmount.toString())
      }
      // else this is a ERC20:ERC20 trade
    } else {
      assert.equal(mgnsIssued.toString(), userBalances.mul(hNum).div(hDen).toString())
    }
    // all claimSellFunds calc returned the same
    assert.equal(claimedAmount.toString(), userBalances.mul(num).div(den).toString())
    // Buyer
  } else if (!nonETH) {
    if (BTName === 'Ether Token') {
      assert.equal(mgnsIssued.toString(), userBalances.toString(),
        'claimBuyerFunds: BT = ETH >--> tulips = buyerBalances')
    } else {
      assert.isTrue(userBalances.mul(den).div(num).gte(mgnsIssued),
        'claimBuyerFunds: ST = ETH >--> tulips = buyerBalances * (den/num)')
    }
    // Trade involves ERC20:ERC20 pair
  } else {
    assert.equal(mgnsIssued.toString(), userBalances.mul(hNum).div(hDen).toString(),
      'claimBuyerFunds: ERC20:ERC20 tulips = buyerBalances * (hNum/hDen)')
  }
}

/**
 * unlockMGNTokens
 * @param {address} user => address to unlock Tokens for
 */
const unlockMGNTokens = async (user, ST, BT) => {
  const { TokenFRT: tokenMGN } = await getContracts()
  // cache auction index for verification of auciton close
  const aucIdx = await getAuctionIndex(ST, BT)

  // cache locked balances Mapping in TokenFRT contract
  // filled automatically after auction closes and TokenFRT.mintTokens is called
  const lockedBalMap = await tokenMGN.lockedTokenBalances.call(user)
  log(`
  TOKENTUL.lockedTokenBalances[user] === ${toEth(lockedBalMap)}
  `)

  // cache the locked Amount of user MGNs from TokenFRT MAP
  // this map is ONLY calculated and filled AFTER auction clears
  const lockedUserMGNs = await tokenMGN.lockedTokenBalances.call(user)
  /*
   * SUB TEST 1: CHECK UNLOCKED AMT + WITHDRAWAL TIME
   * [should be 0,0 as none LOCKED so naturally none to unlock yet]
   */
  const { amountUnlocked: unlockedFunds, withdrawalTime } = await tokenMGN.unlockedTokens.call(user)
  log(`
  AMT OF UNLOCKED FUNDS  = ${toEth(unlockedFunds)}
  TIME OF WITHDRAWAL     = ${withdrawalTime} [0 means no withdraw time as there are 0 locked tokens]
  `)
  assert.isTrue(unlockedFunds.isZero(), 'unlockedFunds should be 0')
  assert.isTrue(withdrawalTime.isZero(), 'Withdraw time should be 0 ')

  /*
   * SUB TEST 2: LOCK TOKENS
   */
  // lock total tulips in lockedMap
  await tokenMGN.lockTokens(lockedUserMGNs, { from: user })
  const totalAmtLocked = await tokenMGN.lockTokens.call(lockedUserMGNs, { from: user })
  log(`
  TOKENS LOCKED          = ${toEth(totalAmtLocked)}
  `)
  if (aucIdx === 2) {
    // auction HAS cleared, TUL should have been minted
    assert.equal(totalAmtLocked.toString(), lockedUserMGNs.toString(), 'Total locked tulips should equal total user balance of tulips')
  } else {
    // auction has NOT cleared, no minting
    assert.isTrue(totalAmtLocked.isZero(), 'Total locked tulips should equal total user balance of tulips')
  }

  /*
   * SUB TEST 3: UN-LOCK TOKENS
   */
  await tokenMGN.unlockTokens({ from: user })
  const { totalAmountUnlocked: unlockedFunds2, withdrawalTime: withdrawalTime2 } = await tokenMGN.unlockTokens.call({ from: user })
  log(`
  AMT OF UNLOCKED FUNDS  = ${toEth(unlockedFunds2)}
  TIME OF WITHDRAWAL     = ${withdrawalTime2} --> ${new Date(withdrawalTime2 * 1000)}
  `)
  if (aucIdx === 2) {
    // Auction HAS cleared
    assert.equal(
      unlockedFunds2.toString(),
      lockedUserMGNs.toString(),
      'unlockedFunds2 should be = lockedUserMGNs')
    // assert withdrawalTime === now (in seconds) + 24 hours (in seconds)
    assert.equal(withdrawalTime2, await timestamp() + (24 * 3600), 'Withdraw time should be equal to [(24 hours in seconds) + (current Block timestamp in seconds)]')
  } else {
    assert.isTrue(unlockedFunds2.isZero(), 'unlockedFunds2 should be = 0 as no tokens minted')
    // assert withdrawalTime === now (in seconds) + 24 hours (in seconds)
    assert.equal(withdrawalTime2, 0, 'Withdraw time should be equal 0 as no Token minted')
  }
}

/**
 * calculateTokensInExchange - calculates the tokens held by the exchange
 * @param {address} token => address to unlock Tokens for
 */
const calculateTokensInExchange = async (Accounts, Tokens) => {
  let results = []
  const { DutchExchange: dx } = await getContracts()
  for (let token of Tokens) {
    // add all normal balances
    let balance = new BN('0')
    for (let acct of Accounts) {
      balance = balance.add((await dx.balances.call(token.address, acct)))
    }

    // check balances in each trading pair token<->tokenToTradeAgainst
    // check through all auctions

    for (let tokenPartner of Tokens) {
      if (token.address !== tokenPartner.address) {
        let lastAuctionIndex = (await dx.getAuctionIndex.call(token.address, tokenPartner.address)).toNumber()
        // check old auctions balances
        for (let auctionIndex = 1; auctionIndex < lastAuctionIndex; auctionIndex += 1) {
          for (let acct of Accounts) {
            const buyerBalance = await dx.buyerBalances.call(token.address, tokenPartner.address, auctionIndex, acct)
            if (buyerBalance.gt(new BN('0'))) {
              const { returned } = await dx.claimBuyerFunds.call(token.address, tokenPartner.address, acct, auctionIndex)
              balance = balance.add(returned)
            }
            const sellerBalance = await dx.sellerBalances.call(tokenPartner.address, token.address, auctionIndex, acct)
            if (sellerBalance.gt(new BN('0'))) {
              const { returned } = await dx.claimSellerFunds.call(tokenPartner.address, token.address, acct, auctionIndex)
              balance = balance.add(returned)
            }
          }
        }
        const [
          getBuyVolumes,
          getSellVolumesCurrent,
          getSellVolumesNext,
          getExtraTokens,
          getExtraTokens1,
          getExtraTokens2
        ] = await Promise.all([
          dx.buyVolumes.call(tokenPartner.address, token.address),
          dx.sellVolumesCurrent.call(token.address, tokenPartner.address),
          dx.sellVolumesNext.call(token.address, tokenPartner.address),
          dx.extraTokens.call(token.address, tokenPartner.address, lastAuctionIndex),
          dx.extraTokens.call(token.address, tokenPartner.address, lastAuctionIndex + 1),
          dx.extraTokens.call(token.address, tokenPartner.address, lastAuctionIndex + 2)
        ])
        // check current auction balances
        balance = balance.add(getBuyVolumes)
        balance = balance.add(getSellVolumesCurrent)

        // check next auction balances
        balance = balance.add(getSellVolumesNext)
        balance = balance.add(getExtraTokens)
        balance = balance.add(getExtraTokens1)
        balance = balance.add(getExtraTokens2)
        // logger('extraTokens',(await dx.extraTokens.call(token.address, tokenPartner.address, lastAuctionIndex)).toNumber())
      }
    }
    results.push(balance)
  }
  return results
}

// checkState is only a rough check for right updates of the numbers in the smart contract. It allows a big tolerance (MaxroundingError)
// since there are unpredicted timejumps with an evm_increase time, which are not caught.
// This should not be a issue, because the focus within these tests is system testing instead of unit testing.
// Testing exact amounts is not needed, since the correct execution of number updates is checked
// with our unit tests within dutchExchange-postBuyOrder/dutchExchange-postSellOrder
const checkState = async (auctionIndex, auctionStart, sellVolumesCurrent, sellVolumesNext, buyVolumes, closingPriceNum, closingPriceDen, ST, BT, MaxRoundingError) => {
  const { DutchExchange: dx } = await getContracts()
  const [
    stBtAuctionIndex,
    btStAuctionIndex,
    getAuctionStart,
    getSellVolumesCurrent,
    getSellVolumesNext,
    getBuyVolumes,
    getClosingPrices
  ] = await Promise.all([
    dx.getAuctionIndex.call(ST.address, BT.address),
    dx.getAuctionIndex.call(BT.address, ST.address),
    dx.getAuctionStart.call(ST.address, BT.address),
    dx.sellVolumesCurrent.call(ST.address, BT.address),
    dx.sellVolumesNext.call(ST.address, BT.address),
    dx.buyVolumes.call(ST.address, BT.address),
    dx.closingPrices.call(ST.address, BT.address, auctionIndex)
  ])

  assert.equal(stBtAuctionIndex.toNumber(), auctionIndex, 'auction index is not correct')
  assert.equal(btStAuctionIndex.toNumber(), auctionIndex, 'auction index is not correct')

  let difference = Math.abs(getAuctionStart.toNumber() - auctionStart)
  assert.isAtMost(difference, 5, 'time difference bigger than 5 sec')
  assert.equal(getSellVolumesCurrent.toString(), sellVolumesCurrent.toString(), ' current SellVolume not correct')
  assert.equal(getSellVolumesNext.toString(), sellVolumesNext.toString(), 'sellVolumeNext is incorrect')
  log('buyVolumes', buyVolumes.toString())
  log(getBuyVolumes.toString())
  difference = getBuyVolumes.sub(buyVolumes).abs().toNumber()
  assert.isAtMost(difference, MaxRoundingError, 'buyVolumes incorrect')

  const { num: closingPriceNumReal, den: closingPriceDenReal } = getClosingPrices
  log('ClosingPriceNumReal', closingPriceNumReal.toString())
  log('ClosingPriceNum', closingPriceNum.toString())
  difference = closingPriceNumReal.sub(closingPriceNum).abs().toNumber()
  assert.isAtMost(difference, MaxRoundingError, 'ClosingPriceNum is not okay')
  assert.equal(closingPriceDenReal.toString(), closingPriceDen.toString(), 'ClosingPriceDen is not okay')
}

const getClearingTime = async (sellToken, buyToken, auctionIndex) => {
  const { DutchExchange: dx } = await getContracts()
  return (await dx.getClearingTime.call(sellToken.address ||
    sellToken, buyToken.address ||
    buyToken, auctionIndex)).toNumber()
}

module.exports = {
  assertClaimingFundsCreatesMGNs,
  assertReturnedPlusMGNs,
  checkBalanceBeforeClaim,
  checkUserReceivesTulipTokens,
  claimBuyerFunds,
  claimSellerFunds,
  getAuctionIndex,
  getBalance,
  getContracts,
  postBuyOrder,
  postSellOrder,
  setAndCheckAuctionStarted,
  setupTest,
  unlockMGNTokens,
  wait: time.increase,
  waitUntilPriceIsXPercentOfPreviousPrice,
  calculateTokensInExchange,
  getClearingTime,
  getAuctionStart,
  checkState
}
