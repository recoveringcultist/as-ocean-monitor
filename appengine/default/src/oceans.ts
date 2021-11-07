import axios from "axios";
import Web3 from "web3";
// const Web3 = require("web3");
import { promises as fs } from "fs";
import * as path from "path";
import BN from "bn.js";
import * as admin from "firebase-admin";

export const JAWS_ADDRESS: string =
  "0xdD97AB35e3C0820215bc85a395e13671d84CCBa2";
export const FINS_ADDRESS: string =
  "0x1b219Aca875f8C74c33CFF9fF98f3a9b62fCbff5";
export const OCEAN_API: string =
  "https://autoshark.finance/.netlify/functions/oceans";
export const SUBGRAPH_API_URL: string =
  "https://api.thegraph.com/subgraphs/name/autoshark-finance/exchange-v1";
export const FARMARMY_API: string = "https://farm.army/api/v0/prices";
export const CACHE_TTL: number = 1000 * 60 * 5; //5 min
export const DB_OCEAN_INFOS: string = "/oceaninfos";
export const DB_OCEAN_INFOS_LASTFETCH: string = "/oceaninfos_lastfetch";

const { DEXGURU_APIKEY } = process.env;

var _oceanInfos: OceanInfo[];
var _oceanInfos_lastFetch: number = 0;
var _currentlyFetching: boolean = false;

/**
 * ocean api result
 */
interface OceanBase {
  name: string;
  depositToken: string;
  earningToken: string;
  address: string;
  depositTokenAddress: string;
  earningTokenAddress: string;
  active: boolean;
}

/**
 * ocean with contract additions
 */
interface Ocean extends OceanBase {
  endsIn: number;
  startsIn: number;
  rewardPerBlock: number;
  totalRewardTokens?: number;
}

/**
 * extra computed ocean information
 */
export interface OceanInfo extends Ocean {
  tvl: number;
  apr: number;
  totalStaked: number;
  tokensAddedToReduceAprBy5?: number;
  depositTokenPrice: number;
  rewardTokenPrice: number;
}

export interface TokenInfo {
  name: string;
  symbol: string;
  address: string;
  decimals: number;
}

interface NetworkCacheItem {
  data: any;
  lastFetchedMillis: number;
}

const w3 = new Web3("https://bsc-dataseed.binance.org");
const abis: any = {};
var _networkCache: {
  [key: string]: NetworkCacheItem;
} = {};

async function getOceans(): Promise<Ocean[]> {
  // grab base data from api
  let data: any = await networkCache(OCEAN_API);
  // let res = await axios.get(OCEAN_API);
  // const oceans: OceanBase[] = (res.data as any).data;
  const oceans: OceanBase[] = data.data;
  let filtered = oceans.filter(
    (o) => o.active /*&&
      addressesIsIn(o.depositTokenAddress, [JAWS_ADDRESS, FINS_ADDRESS])*/
  );

  // filter out oceans whose lastRewardBlock has passed, and add some data from contract
  let curBlock = await w3.eth.getBlockNumber();
  let result: Ocean[] = [];
  for (const o of filtered) {
    let contract = await getOceanContract(o.address);
    let startsIn =
      parseInt(await contract.methods.startBlock().call()) - curBlock;
    let endsIn =
      parseInt(await contract.methods.bonusEndBlock().call()) - curBlock;

    let active = startsIn < 0 && endsIn > 0;
    console.log(
      `ocean ${o.address}, curblock=${curBlock}, startsIn=${startsIn}, endsIn=${endsIn}, active=${active}`
    );
    if (active) {
      let tokenInfo = await getTokenInfo(o.earningTokenAddress);
      let rewardPerBlock = parseFloat(
        fromWeiDecimals(
          await contract.methods.rewardPerBlock().call(),
          tokenInfo.decimals
        )
      );
      let totalRewardTokens = endsIn * rewardPerBlock;

      let extended: Ocean = {
        ...o,
        startsIn,
        endsIn,
        rewardPerBlock,
        totalRewardTokens,
      };
      result.push(extended);
    }
  }

  return result;
}

function cacheIsFresh(lastFetchedMillis: number) {
  return Date.now() - lastFetchedMillis < CACHE_TTL;
}

function secondsAgo(millis: number) {
  return ((Date.now() - millis) / 1000).toFixed(1);
}

export async function getOceanInfos(filterToken?: string, notify?: () => void) {
  let infos = await getOceanInfosInternal(notify);
  if (filterToken) {
    infos = infos.filter((val) =>
      addressesAreEqual(filterToken, val.depositTokenAddress)
    );
  }
  return { infos, lastFetched: _oceanInfos_lastFetch };
}

async function getLastFetchedDB() {
  const db = admin.database();
  let snap = await db.ref(DB_OCEAN_INFOS_LASTFETCH).once("value");
  const val: any = snap.val();
  if (val == null) return 0;
  return val as number;
}

async function getDataDB() {
  const db = admin.database();
  let snap = await db.ref(DB_OCEAN_INFOS).once("value");
  const ret: OceanInfo[] = snap.val();
  return ret;
}

async function getOceanInfosInternal(notify?: () => void) {
  // check last fetched
  _oceanInfos_lastFetch = await getLastFetchedDB();

  if (_currentlyFetching) {
    // stuck fetching for an hour or more? fetch fresh
    if (Date.now() - _oceanInfos_lastFetch > 1000 * 60 * 60) {
      console.log(
        "getOceanInfos: stuck fetching for over an hour, fetching fresh"
      );
      _currentlyFetching = false;
    } else {
      console.log("getOceanInfos: still fetching, returning previous data");
      _oceanInfos = await getDataDB();
      return _oceanInfos;
    }
  }

  // return cached data if still fresh
  let delta = secondsAgo(_oceanInfos_lastFetch);
  if (cacheIsFresh(_oceanInfos_lastFetch)) {
    _oceanInfos = await getDataDB();
    console.log(
      `getOceanInfos: cache still fresh (${delta}s), returning previous data`
    );
    return _oceanInfos;
  }

  // cache is too old, send old data and fetch new data sneakily in background
  console.log(
    `getOceanInfos: cache expired (${delta}s), returning stale data and fetching in bg`
  );
  _oceanInfos = await getDataDB();
  // if (notify) notify();
  fetchData(); // sneaky bg fetch
  return _oceanInfos;
}

async function fetchData() {
  try {
    // fetch data
    if (_oceanInfos_lastFetch == 0) {
      console.log(`getOceanInfos: fetching fresh, first time`);
    } else {
      let delta = secondsAgo(_oceanInfos_lastFetch);
      console.log(
        `getOceanInfos: cache expired, fetching fresh, last fetch ${delta}s ago`
      );
    }
    _currentlyFetching = true;
    let fetchStart = Date.now();
    let oceans = await getOceans();
    let infos: OceanInfo[] = [];
    for (let i = 0; i < oceans.length; i++) {
      let o = oceans[i];
      infos.push(await getOceanInfo(o));
    }
    infos.sort((a, b) => (a.apr < b.apr ? 1 : -1));

    _oceanInfos = infos;
    _oceanInfos_lastFetch = Date.now();
    _currentlyFetching = false;

    // save to db
    const db = admin.database();
    await db.ref(DB_OCEAN_INFOS).set(_oceanInfos);
    await db.ref(DB_OCEAN_INFOS_LASTFETCH).set(_oceanInfos_lastFetch);

    let fetchDuration = Math.round(_oceanInfos_lastFetch - fetchStart);
    console.log(`getOceanInfos: fetch finished in ${fetchDuration} ms`);

    return infos;
  } catch (e) {
    _currentlyFetching = false;
    throw e;
  }
}

export async function getOceanABI() {
  let key = "oceans_abi";
  return cacheABI(key);
}

export async function getTokenABI() {
  let key = "token_abi";
  return cacheABI(key);
}

async function networkCache(url) {
  // return cached data if still fresh
  if (
    _networkCache[url] &&
    cacheIsFresh(_networkCache[url].lastFetchedMillis)
  ) {
    return _networkCache[url].data;
  }

  // fetch data
  let res = await axios.get(url);
  let item: NetworkCacheItem = {
    lastFetchedMillis: Date.now(),
    data: res.data,
  };
  _networkCache[url] = item;
  return res.data;
}

async function cacheABI(key) {
  if (abis[key]) return abis[key];

  let filepath = `./abi/${key}.json`;
  let rawData = await fs.readFile(filepath);
  let abi = JSON.parse(rawData.toString());
  abis[key] = abi;
  return abi;
}

export async function getContract(abi: any, address: string) {
  return new w3.eth.Contract(abi, address);
}

export async function getOceanContract(address: string) {
  let abi = await getOceanABI();
  return getContract(abi, address);
}

export async function getTokenContract(address: string) {
  let abi = await getTokenABI();
  return getContract(abi, address);
}

export async function getTokenPrice(address: string): Promise<number> {
  let tokenInfo = await getTokenInfo(address);

  // look for price in subgraph first
  var query: String = `
  query Token {
      token(id: "${address.toLowerCase()}") {
          id
          symbol
          name
          decimals
          totalSupply
          tradeVolume
          tradeVolumeUSD
          untrackedVolumeUSD
          txCount
          totalLiquidity
          derivedETH
          derivedUSD
      }
  }`;
  let res: any = await axios.post(SUBGRAPH_API_URL, { query: query });
  let token: any = res.data.data.token;
  let subgraphPrice: number = token ? parseFloat(token.derivedUSD) : 0;
  if (token != null && subgraphPrice != 0) {
    return subgraphPrice;
  } else {
    // look for price in other places
    // console.log(
    //   `subgraph has price 0 or no data for ${tokenInfo.symbol}, decimals ${tokenInfo.decimals}`
    // );

    // dex guru
    let url = `https://api.dev.dex.guru/v1/chain/56/tokens/${address}/market?api-key=${DEXGURU_APIKEY!}`;
    try {
      let tokenPriceData: any = await networkCache(url);
      // `https://api.dex.guru/v1/tokens/${address}-bsc?api-key=${DEXGURU_APIKEY!}` // priceUSD
      if (tokenPriceData.price_usd != null) {
        let price = parseFloat(tokenPriceData.price_usd);
        // console.log(`found price of ${tokenInfo.symbol} in dexguru: ${price}`);
        return price;
      }
    } catch (e) {
      console.error(
        "error fetching dexguru from " +
          url +
          "\n" +
          e.toString() +
          "\n" +
          e.stack
      );
    }

    // farm army
    let prices = await networkCache(FARMARMY_API);
    let key = tokenInfo.symbol.toLowerCase();
    if (prices.hasOwnProperty(key)) {
      // console.log(`found price of ${tokenInfo.symbol} in farmarmy api`);
      return parseFloat(prices[key]);
    }

    // couldn't find it, return 0
    // console.log(`price not found for ${key}`);
    return 0;
  }
}

export async function getBnbPrice(): Promise<number> {
  let res: any = await axios.get(
    "https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd"
  );
  return res.data.binancecoin.usd;
}

/**
 * the end block for an ocean
 * @param oceanAddress
 * @returns
 */
export async function ocean_bonusEndBlock(oceanAddress: string) {
  const contract = await getOceanContract(oceanAddress);
  return parseInt(await contract.methods.bonusEndBlock().call());
}

export async function token_symbol(tokenAddress: string) {
  const contract = await getTokenContract(tokenAddress);
  let symbol = await contract.methods.symbol().call();
  return symbol;
}

export async function token_balanceOf(tokenAddress: string, address: string) {
  const info = await getTokenInfo(tokenAddress);
  const contract = await getTokenContract(tokenAddress);
  let balanceOfRes = await contract.methods.balanceOf(address).call();
  return parseFloat(fromWeiDecimals(balanceOfRes.toString(), info.decimals));
}

export async function token_balanceOfWei(
  tokenAddress: string,
  address: string
): Promise<string> {
  const info = await getTokenInfo(tokenAddress);
  const contract = await getTokenContract(tokenAddress);
  let balanceOfRes = await contract.methods.balanceOf(address).call();
  return balanceOfRes.toString();
}

export function fromWeiDecimals(input: string, decimals: number = 18): string {
  if (decimals == 18) {
    return Web3.utils.fromWei(input);
  } else {
    const ten = new BN(10);
    const divisor = ten.pow(new BN(decimals));
    const numerator: BN = new BN(input);
    const result = numerator.div(divisor);
    return result.toString();
  }
}

export async function getTokenInfo(tokenAddress: string) {
  const contract = await getTokenContract(tokenAddress);
  let symbol = await contract.methods.symbol().call();
  let decimals = await contract.methods.decimals().call();
  let name = await contract.methods.name().call();
  let ret: TokenInfo = {
    address: tokenAddress,
    symbol,
    decimals,
    name,
  };
  return ret;
}

async function getOceanInfo(ocean: Ocean) {
  // const oceans = await getOceans();

  // if (which < 0 || which >= oceans.length) {
  //   throw new Error("invalid ocean id");
  // }

  // const ocean = oceans[which];
  let totalStakedWei = await token_balanceOfWei(
    ocean.depositTokenAddress,
    ocean.address
  );
  let totalStaked = parseFloat(fromWeiDecimals(totalStakedWei));
  let depositTokenPrice = await getTokenPrice(ocean.depositTokenAddress);
  let rewardTokenPrice = await getTokenPrice(ocean.earningTokenAddress);
  let TVL = totalStaked * depositTokenPrice;

  let APR = 0;
  // if (depositTokenPrice > 0) {
  //   // (28800 * 365 * rewardPerBlock * rewardTokenPrice) / (totalStaked * depositTokenPrice)
  //   // (28800 * 365 * rewardPerBlock / totalStaked) * (rewardTokenPrice / depositTokenPrice)
  //   // accum = 28800 * 365 * 1e18 * 1e18 * rewardPerBlock / totalStakedWei
  //   let oneE18 = new BN(10).pow(new BN(18));
  //   let totalStakedBN = new BN(totalStakedWei);
  //   let perBlockBN = oneE18.muln(ocean.rewardPerBlock);
  //   let scalar = new BN(28800).mul(new BN(365)).mul(oneE18);
  //   let accum = scalar.mul(perBlockBN).div(totalStakedBN);
  //   // accum = accum * (rewardTokenPrice * 1e18) / 1e18
  //   let rewardBN = oneE18.muln(rewardTokenPrice);
  //   accum = accum.mul(rewardBN).div(oneE18);
  //   // accum = (accum * 1e18) / (depositTokenPrice * 1e18)
  //   let depositBN = oneE18.muln(depositTokenPrice);
  //   accum = accum.mul(oneE18).div(depositBN);
  //   APR = 100 * parseFloat(accum.div(oneE18).toString());
  // }

  if (depositTokenPrice > 0) {
    APR =
      (100 * (28800 * 365 * ocean.rewardPerBlock * rewardTokenPrice)) /
      (totalStaked * depositTokenPrice);
  }

  // let blocksPerYear = 28800 * 365;
  // let dollarsPerBlock = ocean.rewardPerBlock * rewardTokenPrice;
  //  let APR = TVL > 0 ? ((dollarsPerBlock * blocksPerYear) / TVL) * 100 : 0;

  const info: OceanInfo = {
    ...ocean,
    tvl: TVL,
    apr: APR,
    totalStaked,
    depositTokenPrice,
    rewardTokenPrice,
    tokensAddedToReduceAprBy5: totalStaked / 19,
  };
  return info;
}

export function calculateDepositAprDelta(
  apr: number,
  total: number,
  deposit: number
) {
  return -apr / (1 + total / deposit);
}

/**
 * case-insensitive address comparison
 * @param address1
 * @param address2
 * @returns
 */
export function addressesAreEqual(address1: string, address2: string) {
  return address1.toLowerCase() == address2.toLowerCase();
}

export function addressesIsIn(address: string, addresses: string[]) {
  return addresses.find((val) => addressesAreEqual(val, address)) != null;
}

export function blocksToDays(n: number) {
  return n / 28800;
}
