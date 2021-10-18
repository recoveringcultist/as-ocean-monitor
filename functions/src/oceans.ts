import * as functions from "firebase-functions";
import axios from "axios";
import Web3 from "web3";
// const Web3 = require("web3");
import * as fs from "fs";
import * as path from "path";
const w3 = new Web3("https://bsc-dataseed.binance.org");
import { token_abi } from "./token_abi";
import { oceans_abi } from "./oceans_abi";

export const OCEAN_API = "https://autoshark.finance/.netlify/functions/oceans";

export interface Ocean {
  name: string;
  depositToken: string;
  earningToken: string;
  address: string;
  depositTokenAddress: string;
  earningTokenAddress: string;
  active: boolean;
}

export async function getOceans(): Promise<Ocean[]> {
  let res = await axios.get(OCEAN_API);
  const oceans: Ocean[] = (res.data as any).data;
  return oceans;
}

export function getOceanABI() {
  // let filepath = path.join(__dirname, "oceans_abi.json");
  // functions.logger.info(filepath);
  // let rawData = fs.readFileSync(filepath);
  // let abi = rawData.toJSON();
  return oceans_abi;
}

export function getTokenABI() {
  // let filepath = path.join(__dirname, "token_abi.json");
  // functions.logger.info(filepath);
  // let rawData = fs.readFileSync(filepath);
  // let abi = rawData.toJSON();
  return token_abi;
}

export async function getContract(abi: any, address: string) {
  return new w3.eth.Contract(abi, address);
}

export async function getOceanContract(address: string) {
  let abi = getOceanABI();
  return getContract(abi, address);
}

export async function getTokenContract(address: string) {
  let abi = getTokenABI();
  return getContract(abi, address);
}
