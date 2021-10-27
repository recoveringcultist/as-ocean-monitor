import { info } from "console";
import { Context, Markup, Telegraf } from "telegraf";
import Web3 from "web3";
import {
  addressesAreEqual,
  blocksToDays,
  calculateDepositAprDelta,
  FINS_ADDRESS,
  getOceanInfos,
  JAWS_ADDRESS,
  OceanInfo,
} from "./oceans";

const LOCALE_OPTIONS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const LOCALE_OPTIONS_INT = {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
};
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

  let webhookInfo = await bot.telegram.getWebhookInfo();
  console.log("webhookinfo: " + JSON.stringify(webhookInfo));
  try {
    let result = await bot.telegram.deleteWebhook({
      drop_pending_updates: true,
    });
    console.log(`result of deleting old webhook: ${result}`);
  } catch (e) {
    reportError(e, "deleteWebhook error");
  }

  // set new webhook
  const secretPath = `/telegraf/${bot.secretPathComponent()}`;
  try {
    let result = await bot.telegram.setWebhook(
      `https://${GOOGLE_CLOUD_PROJECT!}.uc.r.appspot.com${secretPath}`
    );
    console.log(`result of setting up webhook: ${result}`);
  } catch (e) {
    reportError(e, "setWebhook error");
  }

  webhookInfo = await bot.telegram.getWebhookInfo();
  console.log("webhookinfo: " + JSON.stringify(webhookInfo));

  // Set up the bot's listeners
  bot.start(makeHandler(processStart));
  bot.help((ctx) => ctx.reply("try sending command /start"));
  // bot.on("text", (ctx) => ctx.replyWithHTML("<b>Hello</b>"));
  bot.command("oceans", makeHandler(processListOceans));
  bot.hears(/\/o(\d+)/, makeHandler(oceanInfo));
  bot.hears("hi", (ctx) => ctx.reply("Hey there"));
  bot.on("callback_query", makeHandler(processCallbackQuery));
  bot.launch();

  // Enable graceful stop
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  return bot;
}

const processStart = async (ctx: Context) => {
  console.log(
    `processStart: ${ctx.from.id}, ${ctx.from.first_name}, ${ctx.from.last_name}, ${ctx.from.username}`
  );

  let msg = `Hello <b>${ctx.message.from.first_name}</b>! Welcome to the AS ocean monitor bot.
Available commands:
/start display this message
/oceans list available oceans`;
  return ctx.replyWithHTML(
    msg,
    Markup.inlineKeyboard([
      Markup.button.callback("JAWS oceans", "oceans_jaws"),
      Markup.button.callback("FINS oceans", "oceans_fins"),
    ])
  );
};

const processCallbackQuery = async (ctx: Context) => {
  if ("data" in ctx.callbackQuery) {
    const data = ctx.callbackQuery.data;
    console.log(`processCallbackQuery: ${data}`);
    // process the callback
    let infos: OceanInfo[];
    switch (data) {
      case "oceans_jaws":
        await ctx.answerCbQuery();
        infos = await getOceanInfos(JAWS_ADDRESS);
        return sendOceanList(infos, ctx);
      case "oceans_fins":
        await ctx.answerCbQuery();
        infos = await getOceanInfos(FINS_ADDRESS);
        return sendOceanList(infos, ctx);
    }
    if (data.startsWith("ocean_")) {
      await ctx.answerCbQuery();
      let oceanAddress = data.split("_")[1];
      let infos = await getOceanInfos();
      let info = infos.find((val) =>
        addressesAreEqual(val.address, oceanAddress)
      );
      if (info) {
        return sendOceanInfo(info, ctx);
      }
      return ctx.reply(`i don't know that ocean`);
    }
    return ctx.answerCbQuery(`did you say ${data}?`);
  }
  return ctx.answerCbQuery(`sorry, i didn't catch that`);
};

const processListOceans = async (ctx: Context) => {
  let infos: OceanInfo[] = await getOceanInfos();
  return sendOceanList(infos, ctx);
};

const sendOceanList = async (infos: OceanInfo[], ctx: Context) => {
  const buttons: any[] = [];
  let msg: string = `<b>Please choose an ocean for more info:</b>\n`;
  for (let i = 0; i < infos.length; i++) {
    let info = infos[i];
    // buttons.push(`/o${i}`);
    buttons.push(
      Markup.button.callback(
        `${info.depositToken} for ${info.earningToken}`,
        `ocean_${info.address}`
      )
    );
    msg += `stake ${info.depositToken} for ${info.earningToken}: ${formatNumber(
      info.apr
    )}% APR (end ~${formatNumber(blocksToDays(info.endsIn))}d)\n`;
  }

  return ctx.replyWithHTML(msg, Markup.inlineKeyboard(buttons, { columns: 2 }));
};

const oceanInfo = async (ctx) => {
  return ctx.reply("coming soon");
};

const sendOceanInfo = async (info: OceanInfo, ctx) => {
  let msg = `<b>stake ${info.depositToken} for ${info.earningToken}:</b>
Total staked: ${formatNumber(info.totalStaked)} ${info.depositToken}
${info.depositToken} price: $${info.depositTokenPrice.toFixed(4)}
${info.earningToken} price: $${info.rewardTokenPrice.toFixed(4)}
TVL: $${formatNumber(info.tvl)}
APR: ${formatNumber(info.apr)}%
ends in ~${formatNumber(blocksToDays(info.endsIn))} day(s)`;
  let deposits = [100, 500, 1000, 5000, 10000, 50000];
  for (let deposit of deposits) {
    let delta = calculateDepositAprDelta(info.apr, info.totalStaked, deposit);
    msg += `\nAPR after depositing ${formatInt(deposit)} ${
      info.depositToken
    }: ${formatNumber(info.apr + delta)}%`;
  }

  return ctx.replyWithHTML(msg);
};

const makeHandler = (f: (ctx) => any): ((ctx) => any) => {
  return async (ctx) => {
    try {
      const ret = await f(ctx);
      return ret;
    } catch (e) {
      return reportError(e, "handler error " + f.name, ctx);
    }
  };
};

/**
 * report an error, to console and optionally to tg
 * @param e error object
 * @param msg prepended message
 * @param ctx telegraf context, if provided, sends the error back to tg
 * @returns
 */
function reportError(e, msg, ctx?) {
  console.error(e);
  if (ctx) {
    return ctx.reply(msg + ": " + e.toString() + "\n" + e.stack);
  }
}

function formatNumber(n: number | string) {
  if (typeof n === "string") n = parseFloat(n);
  return n.toLocaleString(undefined, LOCALE_OPTIONS);
}

function formatInt(n: number | string) {
  if (typeof n === "string") n = parseFloat(n);
  return n.toLocaleString(undefined, LOCALE_OPTIONS_INT);
}
