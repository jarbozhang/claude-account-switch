FROM mcr.microsoft.com/playwright:v1.50.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
# scraper 默认入口；dashboard 服务用 command 覆盖
CMD ["bash", "-c", "Xvfb :99 -screen 0 1280x800x24 -ac &\nsleep 1\nDISPLAY=:99 node src/scraper.js"]
