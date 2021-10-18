import * as functions from "firebase-functions";
import { instance } from "firebase-functions/v1/database";
import { Context, Markup, Telegraf } from "telegraf";
import Web3 from "web3";
import {
  getOceanContract,
  getOceans,
  getTokenContract,
  getTokenPrice,
} from "./oceans";

const LOCALE_OPTIONS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

export async function createBot() {
  const { FUNCTION_NAME, PROJECT_ID, REGION } = process.env;

  const BOT_TOKEN = functions.config().telegram.token;
  if (BOT_TOKEN === undefined) {
    throw new TypeError("BOT_TOKEN must be provided!");
  }
  const bot = new Telegraf(BOT_TOKEN);

  // remove old webhook
  let result = await bot.telegram.setWebhook("");
  functions.logger.info(`result of canceling webhook: ${result}`);

  result = await bot.telegram.setWebhook(
    `https://${REGION!}-${PROJECT_ID!}.cloudfunctions.net/${FUNCTION_NAME!}`
  );
  functions.logger.info(`result of setting up webhook: ${result}`);

  bot.start((ctx) => ctx.reply("Welcome"));
  bot.help((ctx) => ctx.reply("try sending command /oceans"));
  bot.command("hello", (ctx) => ctx.reply("Hello, friend!"));
  bot.command("oceans", makeHandler(listOceans));
  bot.hears(/\/o(\d+)/, makeHandler(oceanInfo));
  bot.hears("hi", (ctx) => ctx.reply("Hey there"));
  bot.launch();

  // Enable graceful stop
  // process.once("SIGINT", () => bot.stop("SIGINT"));
  // process.once("SIGTERM", () => bot.stop("SIGTERM"));

  return bot;
}

const listOceans = async (ctx: Context) => {
  const oceans = await getOceans();
  // {"name":"JAWS","depositToken":"JAWS","earningToken":"GUARD","address":"0xF50d7a5066D74c67361176bEddfA0A5379a5d429","depositTokenAddress":"0xdD97AB35e3C0820215bc85a395e13671d84CCBa2","earningTokenAddress":"0xF606bd19b1E61574ED625d9ea96C841D4E247A32","active":true}

  let numOceans = oceans.length;

  const buttons: any[] = [];
  let msg: string = `there are ${numOceans} oceans, which do you want info on?\n`;
  for (let i = 0; i < oceans.length; i++) {
    let o = oceans[i];
    buttons.push(`/o${i}`);
    msg += `/o${i} stake ${o.depositToken} for ${o.earningToken}\n`;
  }

  return ctx.reply(
    msg,
    Markup.keyboard(buttons, { columns: 4 }).oneTime().resize()
  );
};

const oceanInfo = async (ctx) => {
  const oceans = await getOceans();

  const which = parseInt(ctx.match[1]);
  if (which < 0 || which >= oceans.length) {
    return ctx.reply("invalid ocean id");
  }

  const ocean = oceans[which];
  const oceanContract = await getOceanContract(ocean.address);
  const depositToken = await getTokenContract(ocean.depositTokenAddress);
  let totalStakedRes = await depositToken.methods
    .balanceOf(ocean.address)
    .call();
  let totalStaked = parseFloat(Web3.utils.fromWei(totalStakedRes, "ether"));
  let rewardPerBlockRes = await oceanContract.methods.rewardPerBlock().call();
  let rewardPerBlock = parseFloat(
    Web3.utils.fromWei(rewardPerBlockRes, "ether")
  );
  let depositTokenPrice = await getTokenPrice(
    ocean.depositTokenAddress.toLowerCase()
  );
  let rewardTokenPrice = await getTokenPrice(
    ocean.earningTokenAddress.toLowerCase()
  );
  let TVL = totalStaked * depositTokenPrice;
  let blocksPerYear = 28800 * 365;
  let dollarsPerBlock = rewardPerBlock * rewardTokenPrice;
  let APR = ((dollarsPerBlock * blocksPerYear) / TVL) * 100;

  let msg = `ocean ${which}, stake ${ocean.depositToken} for ${
    ocean.earningToken
  }:
Total staked: ${formatNumber(totalStaked)} ${ocean.depositToken}
${ocean.depositToken} price: $${depositTokenPrice.toFixed(4)}
${ocean.earningToken} price: $${rewardTokenPrice.toFixed(4)}
TVL: $${formatNumber(TVL)}
APR: ${formatNumber(APR)}%`;

  return ctx.reply(msg);
};

const makeHandler = (f: (ctx) => any): ((ctx) => any) => {
  return (ctx) => {
    try {
      return f(ctx);
    } catch (e) {
      return reportError(ctx, e, "handler error " + f.name);
    }
  };
};

function reportError(ctx, e, msg) {
  functions.logger.error(e);
  return ctx.reply(msg + ": " + e.toString());
}

function formatNumber(n: number | string) {
  if (typeof n === "string") n = parseFloat(n);
  return n.toLocaleString(undefined, LOCALE_OPTIONS);
}
