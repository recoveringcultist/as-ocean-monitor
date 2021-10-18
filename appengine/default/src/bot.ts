import { Context, Markup, Telegraf } from "telegraf";
import Web3 from "web3";
import {
  getOceanContract,
  getOceans,
  getTokenContract,
  getTokenPrice,
} from "./oceans";

const LOCALE_OPTIONS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const {
  GAE_APPLICATION,
  GAE_SERVICE,
  GAE_VERSION,
  GOOGLE_CLOUD_PROJECT,
  NODE_ENV,
} = process.env;

export async function createBot() {
  console.log("createBot");
  console.log({
    GAE_APPLICATION,
    GAE_SERVICE,
    GAE_VERSION,
    GOOGLE_CLOUD_PROJECT,
    NODE_ENV,
  });

  const token = process.env.BOT_TOKEN;
  if (token === undefined) {
    throw new Error("BOT_TOKEN must be provided!");
  }
  if (GOOGLE_CLOUD_PROJECT === undefined) {
    throw new Error("GOOGLE_CLOUD_PROJECT must be provided!");
  }

  const bot = new Telegraf(token);

  // remove old webhook
  let result = await bot.telegram.setWebhook("");
  console.log(`result of canceling webhook: ${result}`);

  // set new webhook
  const secretPath = `/telegraf/${bot.secretPathComponent()}`;
  result = await bot.telegram.setWebhook(
    `https://${GOOGLE_CLOUD_PROJECT!}.uc.r.appspot.com${secretPath}`
  );
  console.log(`result of setting up webhook: ${result}`);

  // Set the bot response
  bot.start((ctx) => ctx.reply("Welcome"));
  bot.help((ctx) => ctx.reply("try sending command /oceans"));
  // bot.on("text", (ctx) => ctx.replyWithHTML("<b>Hello</b>"));

  bot.command("oceans", makeHandler(listOceans));
  bot.hears(/\/o(\d+)/, makeHandler(oceanInfo));
  bot.hears("hi", (ctx) => ctx.reply("Hey there"));
  bot.launch();

  // Enable graceful stop
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

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
  return async (ctx) => {
    try {
      const ret = await f(ctx);
      return ret;
    } catch (e) {
      return reportError(ctx, e, "handler error " + f.name);
    }
  };
};

function reportError(ctx, e, msg) {
  console.error(e);
  return ctx.reply(msg + ": " + e.toString());
}

function formatNumber(n: number | string) {
  if (typeof n === "string") n = parseFloat(n);
  return n.toLocaleString(undefined, LOCALE_OPTIONS);
}
