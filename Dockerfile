FROM node:18-slim

RUN apt-get update && \
    apt-get install -y ffmpeg libzmq3-dev python3 python3-pip build-essential && \
    pip3 install yt-dlp --break-system-packages && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p media

CMD ["npm", "start"]
