// import { ApolloServer, gql } from 'apollo-server-lambda';
// import { ApolloServerPluginLandingPageGraphQLPlayground } from 'apollo-server-core';

import { typeDefs } from './typeDefs';
import { resolvers } from './resolvers';
import { db } from './db-connection';

import { Handler } from 'aws-lambda';

// const createConnection = async () => {
//   await db();
// };

// createConnection();

// const server = new ApolloServer({
//   typeDefs,
//   resolvers,
//   context: ({ context }) => {
//     context.callbackWaitsForEmptyEventLoop = false;
//   },
//   introspection: true,
//   plugins: [ApolloServerPluginLandingPageGraphQLPlayground()],
// });

// export const handler = server.createHandler({
//   expressGetMiddlewareOptions: {
//     cors: {
//       origin: '*',
//       credentials: true,
//     },
//   },
// });

export const handler: Handler = async (event, context) => {
  console.log('EVENT: \n' + JSON.stringify(event, null, 2));
  return context.logStreamName;
};