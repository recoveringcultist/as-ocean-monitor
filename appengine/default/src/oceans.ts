import axios from "axios";
import Web3 from "web3";
// const Web3 = require("web3");
import { promises as fs } from "fs";
import * as path from "path";
import BN from "bn.js";
import * as admin from "firebase-admin";
import { Context } from "telegraf";

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
export const DB_USERINFO: string = "/userinfo";

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
  title: string;
}

export interface TokenInfo {
  name: string;
  symbol: string;
  address: string;
  decimals: number;
}

export interface UserOceanInfo {
  oceanAddress: string;
  oceanTitle: string;
  balance: number;
  value: number;
  depositToken: string;
  earningToken: string;
  depositTokenAddress: string;
  earningTokenAddress: string;
}

export interface UserInfo {
  id: string;
  botState?: "awaiting_wallet";
  address?: string;
  userOceans?: UserOceanInfo[];
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
  let success = data.data != null;
  let oceans: OceanBase[] = data.data;
  let retries = 0;

  while (!success) {
    data = await networkCache(OCEAN_API, true);
    success = data.data != null;
    oceans = data.data;
    if (!success) {
      console.log(
        `getOceans: problem fetching, retries=${retries}: ` +
          JSON.stringify(data)
      );
    }
    retries++;

    if (retries >= 3) {
      throw new Error("Problem fetching oceans, please try again later");
    }
  }

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

export async function getUserOceans(ctx: Context) {
  const user = await db_getUserInfo(ctx.from.id);
  if (!user.address) {
    // no address!
    return null;
  }
  let userOceanInfos: UserOceanInfo[] = [];
  const infos = await db_getOceansData();
  for (const o of infos) {
    let rewardDecimals = await token_decimals(o.earningTokenAddress);
    let oceanContract = await getOceanContract(o.address);
    let userInfoRes = await oceanContract.methods.userInfo(user.address).call();
    let balance = parseFloat(
      fromWeiDecimals(userInfoRes.amount.toString(), rewardDecimals)
    );

    if (balance > 0) {
      let value = o.depositTokenPrice * balance;
      let userOcean: UserOceanInfo = {
        oceanAddress: o.address,
        oceanTitle: o.title,
        depositToken: o.depositToken,
        depositTokenAddress: o.depositTokenAddress,
        earningToken: o.earningToken,
        earningTokenAddress: o.earningTokenAddress,
        balance,
        value,
      };
      userOceanInfos.push(userOcean);
    }

    // await ctx.reply(JSON.stringify(userInfoRes));
  }

  user.userOceans = userOceanInfos;
  await db_setUserInfo(user);

  return userOceanInfos;
}

/**
 * get information on a list of oceans
 * @param filterToken optional token to filter the list by
 * @param ctx optional telegraph context for notifying the user of status
 * @returns infos, lastFetched, currentlyFetching
 */
export async function getOceanInfos(filterToken?: string, ctx?: Context) {
  let infos = await getOceanInfosInternal(ctx);
  if (filterToken) {
    infos = infos.filter((val) =>
      addressesAreEqual(filterToken, val.depositTokenAddress)
    );
  }
  return {
    infos,
    lastFetched: _oceanInfos_lastFetch,
    currentlyFetching: _currentlyFetching,
  };
}

/**
 * internal implementation
 * @param ctx optional telegraf context to report status to user
 * @returns
 */
async function getOceanInfosInternal(ctx?: Context) {
  // check last fetched
  _oceanInfos_lastFetch = await db_getLastFetched();

  if (_currentlyFetching) {
    // stuck fetching for long time? fetch fresh
    if (Date.now() - _oceanInfos_lastFetch > 1000 * 60 * 5) {
      console.log(`getOceanInfos: stuck fetching for awhile, fetching fresh`);
      _currentlyFetching = false;
    } else {
      console.log("getOceanInfos: still fetching, returning previous data");
      if (ctx) ctx.reply("Fetch in progress, returning cached data");
      _oceanInfos = await db_getOceansData();
      return _oceanInfos;
    }
  }

  // return cached data if still fresh
  let delta = secondsAgo(_oceanInfos_lastFetch);
  if (cacheIsFresh(_oceanInfos_lastFetch)) {
    _oceanInfos = await db_getOceansData();
    console.log(
      `getOceanInfos: cache still fresh (${delta}s), returning previous data`
    );
    return _oceanInfos;
  }

  // cache is too old, send old data and fetch new data sneakily in background
  console.log(
    `getOceanInfos: cache expired (${delta}s), returning stale data and fetching in bg`
  );
  _oceanInfos = await db_getOceansData();
  // sneaky bg fetch
  try {
    fetchOceanData().then(({ infos, fetchDuration }) => {
      if (ctx)
        ctx.reply(
          `Fresh data fetched in ${(fetchDuration / 1000).toFixed(
            1
          )}s! See it by sending /start`
        );
    });
  } catch (e) {
    console.error(
      "error fetching ocean info\n" + e.toString() + "\n" + e.stack
    );
  }
  return _oceanInfos;
}

async function fetchOceanData() {
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

    return { infos, fetchDuration };
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

async function networkCache(url, force = false) {
  // return cached data if still fresh
  if (
    !force &&
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

export function isAddress(address: string) {
  return w3.utils.isAddress(address);
}

export function toChecksumAddress(address: string) {
  return w3.utils.toChecksumAddress(address);
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
  let tokenInfo: TokenInfo = await getTokenInfo(address);

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

    if (tokenInfo.symbol !== "cJAWS") {
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

/**
 * get the symbol for a token
 * @param tokenAddress
 * @returns
 */
export async function token_symbol(tokenAddress: string) {
  const contract = await getTokenContract(tokenAddress);
  let symbol = await contract.methods.symbol().call();
  return symbol;
}

/**
 * get the symbol for a token
 * @param tokenAddress
 * @returns
 */
export async function token_decimals(tokenAddress: string) {
  const contract = await getTokenContract(tokenAddress);
  let decimals = await contract.methods.decimals().call();
  return decimals;
}

/**
 * get balance of token as a float, taking into account token decimals might not be 18
 * @param tokenAddress
 * @param address
 * @returns
 */
export async function token_balanceOf(tokenAddress: string, address: string) {
  const info = await getTokenInfo(tokenAddress);
  const contract = await getTokenContract(tokenAddress);
  let balanceOfRes = await contract.methods.balanceOf(address).call();
  return parseFloat(fromWeiDecimals(balanceOfRes.toString(), info.decimals));
}

/**
 * get balance of a token for an address in wei
 * @param tokenAddress
 * @param address
 * @returns
 */
export async function token_balanceOfWei(
  tokenAddress: string,
  address: string
): Promise<string> {
  const info = await getTokenInfo(tokenAddress);
  const contract = await getTokenContract(tokenAddress);
  let balanceOfRes = await contract.methods.balanceOf(address).call();
  return balanceOfRes.toString();
}

/**
 * get info about a token from the blockchain
 * @param tokenAddress
 * @returns
 */
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

/**
 * convert bigint in string form into float, taking into account token decimals may not be 18
 * @param input
 * @param decimals
 * @returns
 */
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

async function getOceanInfo(ocean: Ocean) {
  let title = ocean.depositToken + " for " + ocean.earningToken;

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
    title,
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

/**
 * get last fetched timestamp from db
 * @returns
 */
async function db_getLastFetched() {
  const db = admin.database();
  let snap = await db.ref(DB_OCEAN_INFOS_LASTFETCH).once("value");
  const val: any = snap.val();
  if (val == null) return 0;
  return val as number;
}

/**
 * get oceans data from db
 * @returns
 */
async function db_getOceansData() {
  const db = admin.database();
  let snap = await db.ref(DB_OCEAN_INFOS).once("value");
  const ret: OceanInfo[] = snap.val();
  return ret;
}

/**
 * get user info from db
 * @returns
 */
export async function db_getUserInfo(id) {
  const db = admin.database();
  const dbPath = `${DB_USERINFO}/${id}`;
  let snap = await db.ref(dbPath).once("value");
  if (!snap.exists()) {
    // create
    const info: UserInfo = {
      id,
    };
    await db.ref(dbPath).set(info);
    return info;
  }

  const res: UserInfo = snap.val();
  return res;
}

/**
 * set user info in db
 * @returns
 */
export async function db_setUserInfo(info: UserInfo) {
  const db = admin.database();
  const dbPath = `${DB_USERINFO}/${info.id}`;
  await db.ref(dbPath).set(info);
}
