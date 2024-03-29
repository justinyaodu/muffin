import "dotenv/config";

import { App } from "@slack/bolt";
import mongoose from "mongoose";

import env from "./env";
import { onReactionAddedToMessage } from "./handlers/reaction";
import { JobRunner } from "./jobs/runner";
import { addReaction, getBotUserId, getUserInfo } from "./services/slack";
import { CommandContext, runCommand } from "./shell/commands";
import { shell } from "./shell/shell";
import { formatUser } from "./util/formatting";

const app = new App({
  token: env.SLACK_BOT_TOKEN,
  signingSecret: env.SLACK_SIGNING_SECRET,
  port: env.PORT,
});

async function processCommandMessage(
  user: string | null,
  text: string,
  context: CommandContext,
) {
  const { event, say } = context;

  console.log(`${user ?? "(unknown user)"} muffin> ${text}`);

  let privileged = false;
  if (user !== null) {
    const userInfoResult = await getUserInfo(app, user);
    if (userInfoResult.ok) {
      privileged = userInfoResult.value.is_admin ?? false;
    } else {
      console.error(
        `shell: could not determine privilege: ${userInfoResult.error}`,
      );
    }
  }

  const result = await runCommand(text, app, context, privileged);
  const reply: string | undefined = result.ok ? result.value : result.error;

  if (typeof reply === "string") {
    console.log(reply);
  }
  console.log(result.ok ? "(ok)" : "(err)");

  const promises: Promise<unknown>[] = [
    addReaction(
      app,
      event.channel,
      event.ts,
      result.ok ? "white_check_mark" : "x",
    ),
  ];
  if (typeof reply === "string") {
    promises.push(say("```" + reply + "```"));
  }

  await Promise.allSettled(promises);
}

app.event("reaction_added", async (context) => {
  const { event } = context;
  await onReactionAddedToMessage(
    app,
    event.user,
    event.item.channel,
    event.item.ts,
    event.reaction,
  );
});

app.event("app_mention", async (context) => {
  // Only respond to messages that start with a mention.
  const botMention = formatUser(env.BOT_USER_ID);
  let text = context.event.text.trimStart();
  if (!text.startsWith(botMention)) {
    // TODO: use postEphemeral to send a hint to the user?
    return;
  }

  // Remove the mention.
  text = text.substring(botMention.length);

  await processCommandMessage(context.event.user ?? null, text, context);
});

app.message(async (context) => {
  const { message } = context;
  if (
    message.channel_type === "im" &&
    message.subtype === undefined &&
    message.text !== undefined &&
    message.user !== "USLACKBOT"
  ) {
    await processCommandMessage(message.user, message.text, context);
  }
});

async function main() {
  console.log(env);

  console.log("connecting to MongoDB...");
  await mongoose.connect(env.MONGODB_URI);
  console.log("connected to MongoDB!");

  console.log(`starting Bolt app...`);
  await app.start();
  console.log("started Bolt app!");

  const botUserIdResult = await getBotUserId(app);
  if (botUserIdResult.ok) {
    const botUserId = botUserIdResult.value;
    (env as { BOT_USER_ID: string }).BOT_USER_ID = botUserId;
    console.log(`bot user ID: ${botUserId}`);
  } else {
    throw new Error(botUserIdResult.error);
  }

  const runner = new JobRunner(app, env.PERIODIC_JOB_INTERVAL_SEC);
  await runner.run();

  shell(app).catch(console.error);

  while (true) {
    await runner.timer.wait();
    await runner.run();
  }
}

main().catch(console.error);
