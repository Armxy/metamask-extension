/* eslint-disable jest/require-top-level-describe, jest/no-export */

import {
  waitForPromiseToBeFulfilledAfterRunningAllTimers,
  withMockedCommunications,
  withNetworkClient,
} from './helpers';
import {
  buildFetchFailedErrorMessage,
  buildInfuraClientRetriesExhaustedErrorMessage,
  buildJsonRpcEngineEmptyResponseErrorMessage,
} from './shared-tests';

/**
 * Defines tests which exercise the behavior exhibited by an RPC method which is
 * assumed to not take a block parameter. Even if it does, the value of this
 * parameter will not be used in determining how to cache the method.
 *
 * @param method - The name of the RPC method under test.
 * @param additionalArgs - Additional arguments.
 * @param additionalArgs.numberOfParameters - The number of parameters supported by the method under test.
 * @param additionalArgs.providerType - The type of provider being tested;
 * either `infura` or `custom` (default: "infura").
 */
export function testsForRpcMethodAssumingNoBlockParam(
  method,
  { numberOfParameters, providerType },
) {
  if (providerType !== 'infura' && providerType !== 'custom') {
    throw new Error(
      `providerType must be either "infura" or "custom", was "${providerType}" instead`,
    );
  }

  it('does not hit the RPC endpoint more than once for identical requests', async () => {
    const requests = [{ method }, { method }];
    const mockResults = ['first result', 'second result'];

    await withMockedCommunications({ providerType }, async (comms) => {
      // The first time a block-cacheable request is made, the latest block
      // number is retrieved through the block tracker first. It doesn't
      // matter what this is — it's just used as a cache key.
      comms.mockNextBlockTrackerRequest();
      comms.mockRpcCall({
        request: requests[0],
        response: { result: mockResults[0] },
      });

      const results = await withNetworkClient(
        { providerType },
        ({ makeRpcCallsInSeries }) => makeRpcCallsInSeries(requests),
      );

      expect(results).toStrictEqual([mockResults[0], mockResults[0]]);
    });
  });

  for (const paramIndex of [...Array(numberOfParameters).keys()]) {
    it(`does not reuse the result of a previous request if parameter at index "${paramIndex}" differs`, async () => {
      const firstMockParams = [
        ...new Array(numberOfParameters).fill('some value'),
      ];
      const secondMockParams = firstMockParams.slice();
      secondMockParams[paramIndex] = 'another value';
      const requests = [
        {
          method,
          params: firstMockParams,
        },
        { method, params: secondMockParams },
      ];
      const mockResults = ['some result', 'another result'];

      await withMockedCommunications({ providerType }, async (comms) => {
        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });
        comms.mockRpcCall({
          request: requests[1],
          response: { result: mockResults[1] },
        });

        const results = await withNetworkClient(
          { providerType },
          ({ makeRpcCallsInSeries }) => makeRpcCallsInSeries(requests),
        );

        expect(results).toStrictEqual([mockResults[0], mockResults[1]]);
      });
    });
  }

  it('hits the RPC endpoint and does not reuse the result of a previous request if the latest block number was updated since', async () => {
    const requests = [{ method }, { method }];
    const mockResults = ['first result', 'second result'];

    await withMockedCommunications({ providerType }, async (comms) => {
      // Note that we have to mock these requests in a specific order. The
      // first block tracker request occurs because of the first RPC request.
      // The second block tracker request, however, does not occur because of
      // the second RPC request, but rather because we call `clock.runAll()`
      // below.
      comms.mockNextBlockTrackerRequest({ blockNumber: '0x1' });
      comms.mockRpcCall({
        request: requests[0],
        response: { result: mockResults[0] },
      });
      comms.mockNextBlockTrackerRequest({ blockNumber: '0x2' });
      comms.mockRpcCall({
        request: requests[1],
        response: { result: mockResults[1] },
      });

      const results = await withNetworkClient(
        { providerType },
        async (client) => {
          const firstResult = await client.makeRpcCall(requests[0]);
          // Proceed to the next iteration of the block tracker so that a new
          // block is fetched and the current block is updated.
          client.clock.runAll();
          const secondResult = await client.makeRpcCall(requests[1]);
          return [firstResult, secondResult];
        },
      );

      expect(results).toStrictEqual(mockResults);
    });
  });

  for (const emptyValue of [null, undefined, '\u003cnil\u003e']) {
    it(`does not retry an empty response of "${emptyValue}"`, async () => {
      const request = { method };
      const mockResult = emptyValue;

      await withMockedCommunications({ providerType }, async (comms) => {
        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          response: { result: mockResult },
        });

        const result = await withNetworkClient(
          { providerType },
          ({ makeRpcCall }) => makeRpcCall(request),
        );

        expect(result).toStrictEqual(mockResult);
      });
    });

    it(`does not reuse the result of a previous request if it was "${emptyValue}"`, async () => {
      const requests = [{ method }, { method }];
      const mockResults = [emptyValue, 'some result'];

      await withMockedCommunications({ providerType }, async (comms) => {
        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });
        comms.mockRpcCall({
          request: requests[1],
          response: { result: mockResults[1] },
        });

        const results = await withNetworkClient(
          { providerType },
          ({ makeRpcCallsInSeries }) => makeRpcCallsInSeries(requests),
        );

        expect(results).toStrictEqual(mockResults);
      });
    });
  }

  it('queues requests while a previous identical call is still pending, then runs the queue when it finishes, reusing the result from the first request', async () => {
    const requests = [{ method }, { method }, { method }];
    const mockResults = ['first result', 'second result', 'third result'];

    await withMockedCommunications({ providerType }, async (comms) => {
      // The first time a block-cacheable request is made, the latest block
      // number is retrieved through the block tracker first. It doesn't
      // matter what this is — it's just used as a cache key.
      comms.mockNextBlockTrackerRequest();
      comms.mockRpcCall({
        request: requests[0],
        response: { result: mockResults[0] },
        delay: 100,
      });

      comms.mockRpcCall({
        request: requests[1],
        response: { result: mockResults[1] },
      });

      comms.mockRpcCall({
        request: requests[2],
        response: { result: mockResults[2] },
      });

      const results = await withNetworkClient(
        { providerType },
        async (client) => {
          const resultPromises = [
            client.makeRpcCall(requests[0]),
            client.makeRpcCall(requests[1]),
            client.makeRpcCall(requests[2]),
          ];
          const firstResult = await resultPromises[0];
          // The inflight cache middleware uses setTimeout to run the handlers,
          // so run them now
          client.clock.runAll();
          const remainingResults = await Promise.all(resultPromises.slice(1));
          return [firstResult, ...remainingResults];
        },
      );

      expect(results).toStrictEqual([
        mockResults[0],
        mockResults[0],
        mockResults[0],
      ]);
    });
  });

  it('throws a custom error if the request to the RPC endpoint returns a 405 response', async () => {
    await withMockedCommunications({ providerType }, async (comms) => {
      const request = { method };

      // The first time a block-cacheable request is made, the latest block
      // number is retrieved through the block tracker first. It doesn't
      // matter what this is — it's just used as a cache key.
      comms.mockNextBlockTrackerRequest();
      comms.mockRpcCall({
        request,
        response: {
          httpStatus: 405,
        },
      });
      const promiseForResult = withNetworkClient(
        { providerType },
        async ({ makeRpcCall }) => makeRpcCall(request),
      );

      await expect(promiseForResult).rejects.toThrow(
        'The method does not exist / is not available',
      );
    });
  });

  // There is a difference in how we are testing the Infura middleware vs. the
  // custom RPC middleware (or, more specifically, the fetch middleware) because
  // of what both middleware treat as rate limiting errors. In this case, the
  // fetch middleware treats a 418 response from the RPC endpoint as such an
  // error, whereas to the Infura middleware, it is a 429 response.
  if (providerType === 'infura') {
    it('throws an undescriptive error if the request to the RPC endpoint returns a 418 response', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { id: 123, method };

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          response: {
            httpStatus: 418,
          },
        });
        const promiseForResult = withNetworkClient(
          { providerType },
          async ({ makeRpcCall }) => makeRpcCall(request),
        );

        await expect(promiseForResult).rejects.toThrow(
          '{"id":123,"jsonrpc":"2.0"}',
        );
      });
    });

    it('throws an error with a custom message if the request to the RPC endpoint returns a 429 response', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          response: {
            httpStatus: 429,
          },
        });
        const promiseForResult = withNetworkClient(
          { providerType },
          async ({ makeRpcCall }) => makeRpcCall(request),
        );

        await expect(promiseForResult).rejects.toThrow(
          'Request is being rate limited',
        );
      });
    });
  } else {
    it('throws a custom error if the request to the RPC endpoint returns a 418 response', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          response: {
            httpStatus: 418,
          },
        });
        const promiseForResult = withNetworkClient(
          { providerType },
          async ({ makeRpcCall }) => makeRpcCall(request),
        );

        await expect(promiseForResult).rejects.toThrow(
          'Request is being rate limited.',
        );
      });
    });

    it('throws an undescriptive error if the request to the RPC endpoint returns a 429 response', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          response: {
            httpStatus: 429,
          },
        });
        const promiseForResult = withNetworkClient(
          { providerType },
          async ({ makeRpcCall }) => makeRpcCall(request),
        );

        await expect(promiseForResult).rejects.toThrow(
          "Non-200 status code: '429'",
        );
      });
    });
  }

  it('throws a generic, undescriptive error if the request to the RPC endpoint returns a response that is not 405, 418, 429, 503, or 504', async () => {
    await withMockedCommunications({ providerType }, async (comms) => {
      const request = { method };

      // The first time a block-cacheable request is made, the latest block
      // number is retrieved through the block tracker first. It doesn't
      // matter what this is — it's just used as a cache key.
      comms.mockNextBlockTrackerRequest();
      comms.mockRpcCall({
        request,
        response: {
          id: 12345,
          jsonrpc: '2.0',
          error: 'some error',
          httpStatus: 420,
        },
      });
      const promiseForResult = withNetworkClient(
        { providerType },
        async ({ makeRpcCall }) => makeRpcCall(request),
      );

      const errorMessage =
        providerType === 'infura'
          ? '{"id":12345,"jsonrpc":"2.0","error":"some error"}'
          : "Non-200 status code: '420'";
      await expect(promiseForResult).rejects.toThrow(errorMessage);
    });
  });

  [503, 504].forEach((httpStatus) => {
    it(`retries the request to the RPC endpoint up to 5 times if it returns a ${httpStatus} response, returning the successful result if there is one on the 5th try`, async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        // Here we have the request fail for the first 4 tries, then succeed
        // on the 5th try.
        comms.mockRpcCall({
          request,
          response: {
            error: 'Some error',
            httpStatus,
          },
          times: 4,
        });
        comms.mockRpcCall({
          request,
          response: {
            result: 'the result',
            httpStatus: 200,
          },
        });
        const result = await withNetworkClient(
          { providerType },
          async ({ makeRpcCall, clock }) => {
            return await waitForPromiseToBeFulfilledAfterRunningAllTimers(
              makeRpcCall(request),
              clock,
            );
          },
        );

        expect(result).toStrictEqual('the result');
      });
    });

    it(`causes a request to fail with a custom error if the request to the RPC endpoint returns a ${httpStatus} response 5 times in a row`, async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          response: {
            error: 'Some error',
            httpStatus,
          },
          times: 5,
        });
        comms.mockNextBlockTrackerRequest();
        const promiseForResult = withNetworkClient(
          { providerType },
          async ({ makeRpcCall, clock }) => {
            return await waitForPromiseToBeFulfilledAfterRunningAllTimers(
              makeRpcCall(request),
              clock,
            );
          },
        );
        const err =
          providerType === 'infura'
            ? buildInfuraClientRetriesExhaustedErrorMessage('Gateway timeout')
            : buildJsonRpcEngineEmptyResponseErrorMessage(method);
        await expect(promiseForResult).rejects.toThrow(err);
      });
    });
  });

  it('retries the request to the RPC endpoint up to 5 times if an "ETIMEDOUT" error is thrown while making the request, returning the successful result if there is one on the 5th try', async () => {
    await withMockedCommunications({ providerType }, async (comms) => {
      const request = { method };

      // The first time a block-cacheable request is made, the latest block
      // number is retrieved through the block tracker first. It doesn't
      // matter what this is — it's just used as a cache key.
      comms.mockNextBlockTrackerRequest();
      // Here we have the request fail for the first 4 tries, then succeed
      // on the 5th try.
      comms.mockRpcCall({
        request,
        error: 'ETIMEDOUT: Some message',
        times: 4,
      });
      comms.mockRpcCall({
        request,
        response: {
          result: 'the result',
          httpStatus: 200,
        },
      });

      const result = await withNetworkClient(
        { providerType },
        async ({ makeRpcCall, clock }) => {
          return await waitForPromiseToBeFulfilledAfterRunningAllTimers(
            makeRpcCall(request),
            clock,
          );
        },
      );

      expect(result).toStrictEqual('the result');
    });
  });

  // Both the Infura and fetch middleware detect ETIMEDOUT errors and will
  // automatically retry the request to the RPC endpoint in question, but both
  // produce a different error if the number of retries is exhausted.
  if (providerType === 'infura') {
    it('causes a request to fail with a custom error if an "ETIMEDOUT" error is thrown while making the request to the RPC endpoint 5 times in a row', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };
        const errorMessage = 'ETIMEDOUT: Some message';

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          error: errorMessage,
          times: 5,
        });
        const promiseForResult = withNetworkClient(
          { providerType },
          async ({ makeRpcCall, clock }) => {
            return await waitForPromiseToBeFulfilledAfterRunningAllTimers(
              makeRpcCall(request),
              clock,
            );
          },
        );

        await expect(promiseForResult).rejects.toThrow(
          buildInfuraClientRetriesExhaustedErrorMessage(errorMessage),
        );
      });
    });
  } else {
    it('returns an empty response if an "ETIMEDOUT" error is thrown while making the request to the RPC endpoint 5 times in a row', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };
        const errorMessage = 'ETIMEDOUT: Some message';

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          error: errorMessage,
          times: 5,
        });
        const promiseForResult = withNetworkClient(
          { providerType },
          async ({ makeRpcCall, clock }) => {
            return await waitForPromiseToBeFulfilledAfterRunningAllTimers(
              makeRpcCall(request),
              clock,
            );
          },
        );

        await expect(promiseForResult).rejects.toThrow(
          buildJsonRpcEngineEmptyResponseErrorMessage(method),
        );
      });
    });
  }

  // The Infura middleware treats a response that contains an ECONNRESET message
  // as an innocuous error that is likely to disappear on a retry. The custom
  // RPC middleware, on the other hand, does not specially handle this error.
  if (providerType === 'infura') {
    it('retries the request to the RPC endpoint up to 5 times if an "ECONNRESET" error is thrown while making the request, returning the successful result if there is one on the 5th try', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        // Here we have the request fail for the first 4 tries, then succeed
        // on the 5th try.
        comms.mockRpcCall({
          request,
          error: 'ECONNRESET: Some message',
          times: 4,
        });
        comms.mockRpcCall({
          request,
          response: {
            result: 'the result',
            httpStatus: 200,
          },
        });

        const result = await withNetworkClient(
          { providerType },
          async ({ makeRpcCall, clock }) => {
            return await waitForPromiseToBeFulfilledAfterRunningAllTimers(
              makeRpcCall(request),
              clock,
            );
          },
        );

        expect(result).toStrictEqual('the result');
      });
    });

    it('causes a request to fail with a custom error if an "ECONNRESET" error is thrown while making the request to the RPC endpoint 5 times in a row', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };
        const errorMessage = 'ECONNRESET: Some message';

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          error: errorMessage,
          times: 5,
        });
        const promiseForResult = withNetworkClient(
          { providerType },
          async ({ makeRpcCall, clock }) => {
            return await waitForPromiseToBeFulfilledAfterRunningAllTimers(
              makeRpcCall(request),
              clock,
            );
          },
        );

        await expect(promiseForResult).rejects.toThrow(
          buildInfuraClientRetriesExhaustedErrorMessage(errorMessage),
        );
      });
    });
  } else {
    it('does not retry the request to the RPC endpoint, but throws immediately, if an "ECONNRESET" error is thrown while making the request', async () => {
      const customRpcUrl = 'http://example.com';

      await withMockedCommunications(
        { providerType, customRpcUrl },
        async (comms) => {
          const request = { method };
          const errorMessage = 'ECONNRESET: Some message';

          // The first time a block-cacheable request is made, the latest block
          // number is retrieved through the block tracker first. It doesn't
          // matter what this is — it's just used as a cache key.
          comms.mockNextBlockTrackerRequest();
          comms.mockRpcCall({
            request,
            error: errorMessage,
          });
          const promiseForResult = withNetworkClient(
            { providerType, customRpcUrl },
            async ({ makeRpcCall }) => makeRpcCall(request),
          );

          await expect(promiseForResult).rejects.toThrow(
            buildFetchFailedErrorMessage(customRpcUrl, errorMessage),
          );
        },
      );
    });
  }

  // Both the Infura and fetch middleware will attempt to parse the response
  // body as JSON, and if this step produces an error, both middleware will also
  // attempt to retry the request. However, this error handling code is slightly
  // different between the two. As the error in this case is a SyntaxError, the
  // Infura middleware will catch it immediately, whereas the custom RPC
  // middleware will catch it and re-throw a separate error, which it then
  // catches later.
  if (providerType === 'infura') {
    it('retries the request to the RPC endpoint up to 5 times if an "SyntaxError" error is thrown while making the request, returning the successful result if there is one on the 5th try', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        // Here we have the request fail for the first 4 tries, then succeed
        // on the 5th try.
        comms.mockRpcCall({
          request,
          error: 'SyntaxError: Some message',
          times: 4,
        });
        comms.mockRpcCall({
          request,
          response: {
            result: 'the result',
            httpStatus: 200,
          },
        });

        const result = await withNetworkClient(
          { providerType },
          async ({ makeRpcCall, clock }) => {
            return await waitForPromiseToBeFulfilledAfterRunningAllTimers(
              makeRpcCall(request),
              clock,
            );
          },
        );

        expect(result).toStrictEqual('the result');
      });
    });

    it('causes a request to fail with a custom error if an "SyntaxError" error is thrown while making the request to the RPC endpoint 5 times in a row', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };
        const errorMessage = 'SyntaxError: Some message';

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          error: errorMessage,
          times: 5,
        });
        const promiseForResult = withNetworkClient(
          { providerType },
          async ({ makeRpcCall, clock }) => {
            return await waitForPromiseToBeFulfilledAfterRunningAllTimers(
              makeRpcCall(request),
              clock,
            );
          },
        );

        await expect(promiseForResult).rejects.toThrow(
          buildInfuraClientRetriesExhaustedErrorMessage(errorMessage),
        );
      });
    });

    it('does not retry the request to the RPC endpoint, but throws immediately, if a "failed to parse response body" error is thrown while making the request', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };
        const errorMessage = 'failed to parse response body: some message';

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          error: errorMessage,
        });
        const promiseForResult = withNetworkClient(
          { providerType, infuraNetwork: comms.infuraNetwork },
          async ({ makeRpcCall }) => makeRpcCall(request),
        );

        await expect(promiseForResult).rejects.toThrow(
          buildFetchFailedErrorMessage(comms.rpcUrl, errorMessage),
        );
      });
    });
  } else {
    it('does not retry the request to the RPC endpoint, but throws immediately, if a "SyntaxError" error is thrown while making the request', async () => {
      const customRpcUrl = 'http://example.com';

      await withMockedCommunications(
        { providerType, customRpcUrl },
        async (comms) => {
          const request = { method };
          const errorMessage = 'SyntaxError: Some message';

          // The first time a block-cacheable request is made, the latest block
          // number is retrieved through the block tracker first. It doesn't
          // matter what this is — it's just used as a cache key.
          comms.mockNextBlockTrackerRequest();
          comms.mockRpcCall({
            request,
            error: errorMessage,
          });
          const promiseForResult = withNetworkClient(
            { providerType, customRpcUrl },
            async ({ makeRpcCall }) => makeRpcCall(request),
          );

          await expect(promiseForResult).rejects.toThrow(
            buildFetchFailedErrorMessage(customRpcUrl, errorMessage),
          );
        },
      );
    });

    it('retries the request to the RPC endpoint up to 5 times if a "failed to parse response body" error is thrown while making the request, returning the successful result if there is one on the 5th try', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        // Here we have the request fail for the first 4 tries, then succeed
        // on the 5th try.
        comms.mockRpcCall({
          request,
          error: 'failed to parse response body: some message',
          times: 4,
        });
        comms.mockRpcCall({
          request,
          response: {
            result: 'the result',
            httpStatus: 200,
          },
        });

        const result = await withNetworkClient(
          { providerType },
          async ({ makeRpcCall, clock }) => {
            return await waitForPromiseToBeFulfilledAfterRunningAllTimers(
              makeRpcCall(request),
              clock,
            );
          },
        );

        expect(result).toStrictEqual('the result');
      });
    });

    it('returns an empty response if a "failed to parse response body" error is thrown while making the request to the RPC endpoint 5 times in a row', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };
        const errorMessage = 'failed to parse response body: some message';

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          error: errorMessage,
          times: 5,
        });
        const promiseForResult = withNetworkClient(
          { providerType },
          async ({ makeRpcCall, clock }) => {
            return await waitForPromiseToBeFulfilledAfterRunningAllTimers(
              makeRpcCall(request),
              clock,
            );
          },
        );

        await expect(promiseForResult).rejects.toThrow(
          buildJsonRpcEngineEmptyResponseErrorMessage(method),
        );
      });
    });
  }

  // Only the custom RPC middleware will detect a "Failed to fetch" error and
  // attempt to retry the request to the RPC endpoint; the Infura middleware
  // does not.
  if (providerType === 'infura') {
    it('does not retry the request to the RPC endpoint, but throws immediately, if a "Failed to fetch" error is thrown while making the request', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };
        const errorMessage = 'Failed to fetch: some message';

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          error: errorMessage,
        });
        const promiseForResult = withNetworkClient(
          { providerType, infuraNetwork: comms.infuraNetwork },
          async ({ makeRpcCall }) => makeRpcCall(request),
        );

        await expect(promiseForResult).rejects.toThrow(
          buildFetchFailedErrorMessage(comms.rpcUrl, errorMessage),
        );
      });
    });
  } else {
    it('retries the request to the RPC endpoint up to 5 times if a "Failed to fetch" error is thrown while making the request, returning the successful result if there is one on the 5th try', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        // Here we have the request fail for the first 4 tries, then succeed
        // on the 5th try.
        comms.mockRpcCall({
          request,
          error: 'Failed to fetch: some message',
          times: 4,
        });
        comms.mockRpcCall({
          request,
          response: {
            result: 'the result',
            httpStatus: 200,
          },
        });

        const result = await withNetworkClient(
          { providerType },
          async ({ makeRpcCall, clock }) => {
            return await waitForPromiseToBeFulfilledAfterRunningAllTimers(
              makeRpcCall(request),
              clock,
            );
          },
        );

        expect(result).toStrictEqual('the result');
      });
    });

    it('returns an empty response if a "Failed to fetch" error is thrown while making the request to the RPC endpoint 5 times in a row', async () => {
      await withMockedCommunications({ providerType }, async (comms) => {
        const request = { method };
        const errorMessage = 'Failed to fetch: some message';

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockRpcCall({
          request,
          error: errorMessage,
          times: 5,
        });
        const promiseForResult = withNetworkClient(
          { providerType },
          async ({ makeRpcCall, clock }) => {
            return await waitForPromiseToBeFulfilledAfterRunningAllTimers(
              makeRpcCall(request),
              clock,
            );
          },
        );

        await expect(promiseForResult).rejects.toThrow(
          buildJsonRpcEngineEmptyResponseErrorMessage(method),
        );
      });
    });
  }
}
