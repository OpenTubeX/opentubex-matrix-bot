# OpenTubeX Matrix bot

Lets people in the OpenTubeX Matrix rooms file GitHub issues without a GitHub account.

## Commands

```text
!bug Short summary
What happened, the steps to reproduce it, and so on.
```

```text
!feature Short summary
What you want and why.
```

`!help`, or a command without a summary, explains the commands.

When a message mentions an issue or pull request like `#123`, the bot replies with its title, its status, and a link. It links each issue at most once every 30 minutes per room.

## What it does

- The first line becomes the issue title and the rest its description. The issue says who reported it on Matrix and links to the message.
- The bot answers in a thread on the command message. Replies in that thread are posted as comments, and GitHub comments, closes, and reopens are posted back into the thread, mentioning the reporter.
- The bot mirrors edits and removals on both sides. Removing the command message closes the issue and replaces its text.
- Each Matrix user can file 10 reports a day, and the bot files at most 20 a day in total. Each user can post 30 replies an hour.
- The bot does not copy files to GitHub, and it does not work in encrypted rooms.
