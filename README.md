# MaxOS

MaxOS is an open-source browser-based operating system and web workspace. It is designed to let users store files, open apps, share content, and use a computer-like environment directly from the web, without needing to rely on local storage on their own computer.

The goal of MaxOS is to make a simple cloud desktop that can run in a browser and be useful for students, classrooms, small projects, and anyone who wants a lightweight online workspace.

## Features

* Browser-based desktop interface
* User accounts
* Online file storage
* MongoDB-backed persistent data
* App-style interface
* File sharing
* Notes, documents, forms, and workspace tools
* Game/app support
* iPad/mobile-friendly mode
* Real-time features using Socket.IO
* Teacher/classroom mode ideas
* Offline-capable app shell concepts
* Moderation and admin tools

## Why MaxOS Exists

Most operating systems store files locally on one computer. MaxOS is different because it is built around the idea that your workspace can live on the web.

MaxOS is meant to be:

* easy to access from different devices
* simple enough for students to use
* flexible enough for developers to expand
* open source so other people can learn from it and improve it

## Tech Stack

MaxOS is mainly built with:

* HTML
* CSS
* JavaScript
* Node.js
* Express
* MongoDB
* Socket.IO

## Project Status

MaxOS is still in active development. Some features are finished, some are experimental, and others are planned. The project is growing over time as new apps, UI improvements, security fixes, and collaboration tools are added.

This is not a finished production operating system. It is an open-source web OS project that is being actively built and improved.

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/maxvbuda/maxos.git
cd maxos
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create an environment file

Create a `.env` file in the project folder.

Example:

```env
MONGODB_URI=your_mongodb_connection_string
SESSION_SECRET=your_session_secret
PORT=3000
```

Do not share your real `.env` file publicly.

### 4. Start the server

```bash
npm start
```

Or, if the project uses a direct server file:

```bash
node server.js
```

### 5. Open MaxOS

Go to:

```text
http://localhost:3000
```

## Contributing

Contributions are welcome. You can help by:

* fixing bugs
* improving the interface
* adding apps
* improving documentation
* testing on different devices
* improving security
* making setup easier
* suggesting new features

Before making big changes, it is a good idea to open an issue or discussion so the idea can be planned first.

## Possible Future Ideas

* Better file manager
* More built-in apps
* Better app installation system
* Improved classroom tools
* Shared folders
* More permissions and safety tools
* Better mobile and iPad support
* Themes and customization
* More offline support
* Public app marketplace
* Better documentation for developers

## Security

MaxOS includes user accounts and stored data, so security is important. If you find a security problem, please do not publicly post private information, passwords, database URLs, or exploit details. Open an issue with a safe description or contact the maintainer privately if needed.

## License

This project is open source. Licensed using Apache 2.0.

## Maintainer

Created and maintained by [@maxvbuda](https://github.com/maxvbuda).

## Project Goal

MaxOS is a learning-focused open-source project with a big goal: to build a web-based operating system where files, apps, sharing, and collaboration all happen inside the browser.
