import {
  ApolloLink,
  Operation,
  FetchResult,
  Observable,
  fromError,
} from 'apollo-link';
import {
  serializeFetchParameter,
  selectURI,
  parseAndCheckHttpResponse,
  checkFetcher,
  selectHttpOptionsAndBody,
  createSignalIfSupported,
  fallbackHttpConfig,
  HttpOptions,
} from 'apollo-link-http-common';
import { BatchLink } from 'apollo-link-batch';

export namespace BatchHttpLink {
  export interface Options extends HttpOptions {
    /**
     * The maximum number of operations to include in one fetch.
     *
     * Defaults to 10.
     */
    batchMax?: number;

    /**
     * The interval at which to batch, in milliseconds.
     *
     * Defaults to 10.
     */
    batchInterval?: number;

    /**
     * Sets the key for an Operation, which specifies the batch an operation is included in
     */
    batchKey?: (Operation) => string;
  }
}

/**
 * Transforms Operation for into HTTP results.
 * context can include the headers property, which will be passed to the fetch function
 */
export class BatchHttpLink extends ApolloLink {
  private batchInterval: number;
  private batchMax: number;
  private batcher: ApolloLink;

  constructor(fetchParams: BatchHttpLink.Options = {}) {
    super();

    let {
      uri = '/graphql',
      // use default global fetch is nothing passed in
      fetch: fetcher,
      includeExtensions,
      batchInterval,
      batchMax,
      batchKey,
      ...requestOptions
    } = fetchParams;

    // dev warnings to ensure fetch is present
    checkFetcher(fetcher);

    //fetcher is set here rather than the destructuring to ensure fetch is
    //declared before referencing it. Reference in the destructuring would cause
    //a ReferenceError
    if (!fetcher) {
      fetcher = fetch;
    }

    const linkConfig = {
      http: { includeExtensions },
      options: requestOptions.fetchOptions,
      credentials: requestOptions.credentials,
      headers: requestOptions.headers,
    };

    this.batchInterval = batchInterval || 10;
    this.batchMax = batchMax || 10;

    const batchHandler = (operations: Operation[]) => {
      const chosenURI = selectURI(operations[0], uri);

      const context = operations[0].getContext();

      const contextConfig = {
        http: context.http,
        options: context.fetchOptions,
        credentials: context.credentials,
        headers: context.headers,
      };

      //uses fallback, link, and then context to build options
      const optsAndBody = operations.map(operation =>
        selectHttpOptionsAndBody(
          operation,
          fallbackHttpConfig,
          linkConfig,
          contextConfig,
        ),
      );

      const body = optsAndBody.map(({ body }) => body);
      const options = optsAndBody[0].options;

      // There's no spec for using GET with batches.
      if (options.method === 'GET') {
        return fromError<FetchResult[]>(
          new Error('apollo-link-batch-http does not support GET requests'),
        );
      }

      try {
        (options as any).body = serializeFetchParameter(body, 'Payload');
      } catch (parseError) {
        return fromError<FetchResult[]>(parseError);
      }

      const { controller, signal } = createSignalIfSupported();
      if (controller) (options as any).signal = signal;

      return new Observable<FetchResult[]>(observer => {
        // the raw response is attached to the context in the BatchingLink
        fetcher(chosenURI, options)
          .then(parseAndCheckHttpResponse(operations))
          .then(result => {
            // we have data and can send it to back up the link chain
            observer.next(result);
            observer.complete();
            return result;
          })
          .catch(err => {
            // fetch was cancelled so its already been cleaned up in the unsubscribe
            if (err.name === 'AbortError') return;
            observer.error(err);
          });

        return () => {
          // XXX support canceling this request
          // https://developers.google.com/web/updates/2017/09/abortable-fetch
          if (controller) controller.abort();
        };
      });
    };

    batchKey =
      batchKey ||
      ((operation: Operation) => {
        const context = operation.getContext();

        const contextConfig = {
          http: context.http,
          options: context.fetchOptions,
          credentials: context.credentials,
          headers: context.headers,
        };

        //may throw error if config not serializable
        return selectURI(operation, uri) + JSON.stringify(contextConfig);
      });

    this.batcher = new BatchLink({
      batchInterval: this.batchInterval,
      batchMax: this.batchMax,
      batchKey,
      batchHandler,
    });
  }

  public request(operation: Operation): Observable<FetchResult> | null {
    return this.batcher.request(operation);
  }
}
