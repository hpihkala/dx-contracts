pragma solidity ^0.4.25;

import "@gnosis.pm/util-contracts/contracts/Proxy.sol";

contract DutchExchangeProxy is Proxy {
  function DutchExchangeProxy(address _masterCopy) Proxy (_masterCopy) {
  }
}