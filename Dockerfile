FROM node:14

ADD ./ /app
WORKDIR /app
RUN npm -g install

CMD ["/usr/local/bin/node", "/app/app.js"]
