/* global contract, assert, artifacts */
/* eslint no-undef: "error" */

const {
  assertRejects,
  gasLogger,
  enableContractFlag,
  toEth
} = require('./utils')

const {
  getContracts,
  setupTest,
  wait
} = require('./testFunctions')

const Medianizer = artifacts.require('Medianizer')
const PriceFeed = artifacts.require('PriceFeed')
const PriceOracleInterface = artifacts.require('PriceOracleInterface')

// Test VARS
let oracle
let priceFeed
let dx
let medzr2
let contracts
let newPriceOracleInterface

const setupContracts = async () => {
  contracts = await getContracts({ resetCache: true });
  // destructure contracts into upper state
  ({
    PriceOracleInterface: oracle,
    PriceFeed: priceFeed,
    DutchExchange: dx
  } = contracts)
}

const c1 = () => contract('DX PriceOracleInterface Flow', accounts => {
  const [owner, notOwner, newCurator] = accounts
  // Accounts to fund for faster setupTest
  const setupAccounts = [owner, notOwner, newCurator]

  const startBal = {
    startingETH: 1000.0.toWei(),
    startingGNO: 1000.0.toWei(),
    ethUSDPrice: 1100.0.toWei(), // 400 ETH @ $6000/ETH = $2,400,000 USD
    sellingAmount: 100.0.toWei() // Same as web3.toWei(50, 'ether') - $60,000USD
  }

  afterEach(gasLogger)

  it('SETUP: fund accounts, fund DX', async () => {
    // get contracts
    await setupContracts()
    contracts.medzr2 = await Medianizer.new()
    contracts.priceFeed2 = await PriceFeed.new();
    ({ medzr2 } = contracts)

    // set up accounts and tokens[contracts]
    await setupTest(setupAccounts, contracts, startBal)
  })

  it('raiseEmergency: throws when NON-OWNER tries to call it', async () =>
    assertRejects(oracle.raiseEmergency(true, { from: notOwner }))
  )

  it('raiseEmergency: switches into emergency mode', async () => {
    await oracle.raiseEmergency(true, { from: owner })

    let ethUSDPrice = (await oracle.getUSDETHPrice.call()).toNumber()
    assert.equal(ethUSDPrice, 600, 'Oracle ethUSDPrice should report emergency price')
    await oracle.raiseEmergency(false, { from: owner })

    ethUSDPrice = (await oracle.getUSDETHPrice.call()).toNumber()
    assert.equal(ethUSDPrice, 1100, 'Oracle ethUSDPrice should on longer report emergency price')
  })

  it('getUSDETHPrice: calls this correctly', async () => {
    const ethUSDPrice = (await oracle.getUSDETHPrice.call()).toNumber()
    assert.equal(ethUSDPrice, 1100, 'Oracle ethUSDPrice is not the set price ethUSDPrice: 1100..toWei(),')
  })

  it('getUSDETHPrice: price is correctly restricted if actual price is 0', async () => {
    newPriceOracleInterface = await PriceOracleInterface.new(owner, medzr2.address)
    await dx.initiateEthUsdOracleUpdate(newPriceOracleInterface.address, { from: owner })
    await assertRejects(dx.updateEthUSDOracle({ from: owner }))
    await wait(60 * 60 * 24 * 30 + 5)
    await dx.updateEthUSDOracle({ from: owner })
    const ethUSDPrice = (await newPriceOracleInterface.getUSDETHPrice.call()).toNumber()
    assert.equal(ethUSDPrice, 1, 'Oracle ethUSDPrice is not set and should return 1')
  })
  it('getUSDETHPrice: set price should work correctly', async () => {
    const ethUSDPrice = 1500.0.toWei()
    const medzr = await Medianizer.at(medzr2.address)
    await medzr.set(PriceFeed.address, { from: owner })
    await priceFeed.post(ethUSDPrice, 1516168838 * 2, medzr2.address, { from: owner })
    const getNewETHUSDPrice = await newPriceOracleInterface.getUSDETHPrice.call()

    assert.equal(toEth(ethUSDPrice).toString(), getNewETHUSDPrice.toString(), 'Should be same')
  })

  it('updateCurator: throws when NON-OWNER tries to change curator',
    async () => assertRejects(oracle.updateCurator(medzr2, { from: notOwner }))
  )

  it('updateCurator: switches OWNER to new OWNER', async () => {
    const oldOwner = await oracle.owner.call()
    await oracle.updateCurator(newCurator, { from: owner })
    const newOwner = await oracle.owner.call()

    assert.notEqual(oldOwner, newOwner, 'Old Owner should NOT == New Owner')
    assert.equal(newCurator, newOwner, 'New Curator passed in is indeed newOwner')
  })
})

enableContractFlag(c1)
