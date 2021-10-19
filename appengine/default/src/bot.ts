import { info } from "console";
import { Context, Markup, Telegraf } from "telegraf";
import Web3 from "web3";
import { getOceanInfos, OceanInfo } from "./oceans";

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
  let infos: OceanInfo[] = await getOceanInfos(true);

  let numOceans = infos.length;
  const buttons: any[] = [];
  let msg: string = `there are ${numOceans} active oceans, which do you want info on?\n`;
  for (let i = 0; i < infos.length; i++) {
    let info = infos[i];
    buttons.push(`/o${i}`);
    msg += `/o${i} stake ${info.depositToken} for ${
      info.earningToken
    }: ${formatNumber(info.apr)}% APR\n`;
  }

  return ctx.reply(
    msg,
    Markup.keyboard(buttons, { columns: 4 }).oneTime().resize()
  );
};

const oceanInfo = async (ctx) => {
  const oceans = await getOceanInfos(true);

  const which = parseInt(ctx.match[1]);
  if (which < 0 || which >= oceans.length) {
    return ctx.reply("invalid ocean id");
  }

  // const ocean = oceans[which];

  // const info = await getOceanInfo(ocean);

  const info = oceans[which];

  let msg = `ocean ${which}, stake ${info.depositToken} for ${
    info.earningToken
  }:
Total staked: ${formatNumber(info.totalStaked)} ${info.depositToken}
${info.depositToken} price: $${info.depositTokenPrice.toFixed(4)}
${info.earningToken} price: $${info.rewardTokenPrice.toFixed(4)}
TVL: $${formatNumber(info.tvl)}
APR: ${formatNumber(info.apr)}%`;

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
  return ctx.reply(msg + ": " + e.toString() + "\n" + e.stack);
}

function formatNumber(n: number | string) {
  if (typeof n === "string") n = parseFloat(n);
  return n.toLocaleString(undefined, LOCALE_OPTIONS);
}
