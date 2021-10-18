import axios from "axios";
import Web3 from "web3";
// const Web3 = require("web3");
import { promises as fs } from "fs";
import * as path from "path";

export const OCEAN_API = "https://autoshark.finance/.netlify/functions/oceans";

export const SUBGRAPH_API_URL: string =
  "https://api.thegraph.com/subgraphs/name/autoshark-finance/exchange-v1";

export interface Ocean {
  name: string;
  depositToken: string;
  earningToken: string;
  address: string;
  depositTokenAddress: string;
  earningTokenAddress: string;
  active: boolean;
}

const w3 = new Web3("https://bsc-dataseed.binance.org");
const abis: any = {};

export async function getOceans(): Promise<Ocean[]> {
  let res = await axios.get(OCEAN_API);
  const oceans: Ocean[] = (res.data as any).data;
  let activeOceans = oceans.filter((o) => o.active);
  return activeOceans;
}

export async function getOceanABI() {
  let key = "oceans_abi";
  return cacheABI(key);
}

export async function getTokenABI() {
  let key = "token_abi";
  return cacheABI(key);
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
  var query: String = `
  query Token {
      token(id: "${address}") {
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
  let data: any = await axios.post(SUBGRAPH_API_URL, { query: query });
  return parseFloat(data.data.data.token.derivedUSD);
}

export async function getBnbPrice(): Promise<number> {
  let res: any = await axios.get(
    "https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd"
  );
  return res.data.binancecoin.usd;
}
