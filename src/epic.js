// @flow

import dayjs from 'dayjs';
import get from 'lodash/get';
import isArray from 'lodash/isArray';
import { combineEpics, ofType } from 'redux-observable';
import { of, from } from 'rxjs';
import { map, filter, catchError, mergeMap } from 'rxjs/operators';
import type {
  Ducks,
  RequestEpicParam,
  RequestByKeyEpicParam,
  FetchIfNeededEpicParam,
  FetchByKeyIfNeededEpicParam,
} from './type';
import { config } from './config';

/*

*/

/* LOGIC
1. isFetching -> false
2. lastUpdate > cacheDuration -> true
3. paging && itemsEnd -> false
4. !cache -> true
5. paging && fresh && payload !== undefined -> false
6. paging && !paginationFetch.page -> true
7. payload === undefined -> true
8. didInvalidate
*/

const shouldFetchPageIfNeeded = (state: Object, options: Object, action: Object) => {
  const lastUpdated = dayjs(state.lastUpdated);
  if (
    lastUpdated.isValid() &&
    lastUpdated.add(options.cacheDuration, 'seconds').isBefore(dayjs())
  ) {
    action.params.page = 0; // reset page if data expired
    return true;
  }
  if (state.itemsEnd) {
    return false;
  }
  if (action.params.fresh && state.payload !== undefined) {
    return false;
  }
  if (!get(state, `paginationFetched.${state.page}`)) {
    return true;
  }
  if (state.payload === undefined) {
    return true;
  }
  return state.didInvalidate;
};

const shouldFetchIfNeeded = (state: Object, options: Object, action: Object) => {
  if (!state) {
    return true;
  }
  if (state.isFetching) {
    return false;
  }
  if (options.paging) {
    return shouldFetchPageIfNeeded(state, options, action);
  }
  if (!options.cache) {
    return true;
  }
  const lastUpdated = dayjs(state.lastUpdated);
  if (
    lastUpdated.isValid() &&
    lastUpdated.add(options.cacheDuration, 'seconds').isBefore(dayjs())
  ) {
    return true;
  }
  if (state.payload === undefined) {
    return true;
  }
  return state.didInvalidate;
};

export const getShouldFetchKeys = (state: any, keys: any, options: Object, action: Object) => {
  if (keys && keys.constructor === Array) {
    const shouldFetchKeys = [];
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (shouldFetchIfNeeded(state[key], options, action)) {
        shouldFetchKeys.push(key);
      }
    }
    return shouldFetchKeys;
  }
  if (shouldFetchIfNeeded(state[keys], options, action)) {
    return keys;
  }
  return undefined;
};

export const createFetchIfNeededEpic = ({ ducks, options }: FetchIfNeededEpicParam) => {
  const { requestTypes, requestActions, selector } = ducks;
  return (action$: any, state$: any) =>
    action$.pipe(
      ofType(requestTypes.FETCH),
      filter(action => shouldFetchIfNeeded(selector(state$.value), options, action)),
      map(action =>
        requestActions.request({
          ...action.params,
          page: get(selector(state$.value), 'page'),
        }),
      ),
    );
};

const shouldContinueFetch = (shouldFetchKeys) => {
  if (shouldFetchKeys && shouldFetchKeys.constructor === Array) {
    return shouldFetchKeys.length;
  }
  return !!shouldFetchKeys;
};

export const createFetchByKeyIfNeededEpic = ({
  ducks,
  mapActionToKey,
  restoreFetchableKeyToAction,
  options,
}: FetchByKeyIfNeededEpicParam) => {
  const { requestTypes, requestActions, selector } = ducks;
  return (action$: any, state$: any) =>
    action$.pipe(
      ofType(requestTypes.FETCH),
      map((_action) => {
        const action = {
          ..._action,
        };
        const keys = mapActionToKey(action);
        const shouldFetchKeys = getShouldFetchKeys(selector(state$.value), keys, options, action);
        if (shouldContinueFetch(shouldFetchKeys)) {
          if (restoreFetchableKeyToAction) {
            restoreFetchableKeyToAction(action, shouldFetchKeys);
          }
          action.shouldFetch = true;
        }
        return action;
      }),
      filter(action => action.shouldFetch),
      map((action) => {
        if (get(options, 'paging')) {
          const result = get(selector(state$.value), mapActionToKey(action));
          const page = get(result, 'page') || 0;
          return requestActions.request({
            ...action.params,
            page,
          });
        }
        return requestActions.request(action.params);
      }),
    );
};

export const createRequestEpic = ({ ducks, api, options }: RequestEpicParam) => {
  const { requestTypes, requestActions } = ducks;

  const requestEpic = (action$: any, store: any) =>
    action$.pipe(
      ofType(requestTypes.REQUEST),
      mergeMap(action => {
        console.log(action);
        return from(api(action.params, store)).pipe(
          map((data) => {
            if (get(action, 'params.resolve') && options.handleParamsPromiseResolve) {
              action.params.resolve(data);
            }
            return requestActions.success(data, action.params);
          }),
          catchError((error) => {
            console.log(error);
            console.log(JSON.stringify(error));
            if (get(action, 'params.reject') && options.handleParamsPromiseReject) {
              action.params.reject(error);
            }
            return of(requestActions.failure(error, action.params));
          }),
        )
      }),
    );

  let handlerEpics = [];
  if (options.handlers && options.handlers.length) {
    handlerEpics = options.handlers.map(handler => handler(ducks));
  }
  return combineEpics(requestEpic, ...handlerEpics);
};

export const createRequestIfNeededEpic = ({ ducks, api, options }: RequestEpicParam) => {
  const mergeOptions = {
    ...config.requestOptions,
    ...options,
  };
  const fetchItemsIfNeededEpic = createFetchIfNeededEpic({
    ducks,
    options: mergeOptions,
  });
  const requestEpic = createRequestEpic({ ducks, api, options: mergeOptions });
  return combineEpics(fetchItemsIfNeededEpic, requestEpic);
};

export const createRequestByKeyIfNeededEpic = ({
  ducks,
  api,
  mapActionToKey,
  restoreFetchableKeyToAction,
  options = config.requestOptions,
}: RequestByKeyEpicParam) => {
  const mergeOptions = {
    ...config.requestOptions,
    ...options,
  };
  const fetchByKeyIfNeededEpic = createFetchByKeyIfNeededEpic({
    ducks,
    mapActionToKey,
    restoreFetchableKeyToAction,
    options: mergeOptions,
  });
  const requestEpic = createRequestEpic({ ducks, api, options: mergeOptions });
  return combineEpics(fetchByKeyIfNeededEpic, requestEpic);
};

type CacheEvictProps = {
  conditionType: Array<string> | string,
  ducks: Ducks,
  filter?: Function,
  mapActionToKey?: Function,
  mapActionToParams?: Function,
};

export const createCacheRefreshEpic = ({
  conditionType,
  ducks,
  filter: refreshFilter,
  mapActionToParams,
  mapActionToKey,
}: CacheEvictProps) => (action$: any, state$: any) =>
  action$.pipe(
    filter((action) => {
      if (action.type === conditionType) {
        return true;
      }
      return isArray(conditionType) && conditionType.indexOf(action.type) > -1;
    }),
    filter((action) => {
      if (refreshFilter) {
        return refreshFilter(state$.value);
      }
      if (mapActionToParams && mapActionToKey) {
        const key = mapActionToKey({
          params: mapActionToParams(action, state$.value),
        });
        return get(get(ducks.selector(state$.value), key), 'payload') !== undefined;
      }
      return get(ducks.selector(state$.value), 'payload') !== undefined;
    }),
    mergeMap((action) => {
      const params = mapActionToParams ? mapActionToParams(action, state$.value) : {};
      return of(ducks.requestActions.clear(params), ducks.requestActions.fetch(params));
    }),
  );

export const createCacheEvictEpic = ({
  conditionType,
  ducks,
  filter: evictFilter,
}: CacheEvictProps) => (action$: any, state$: any) =>
  action$.pipe(
    filter((action) => {
      if (action.type === conditionType) {
        return true;
      }
      return isArray(conditionType) && conditionType.indexOf(action.type) > -1;
    }),
    filter(() => {
      if (evictFilter) {
        return evictFilter(state$.value);
      }
      return true;
    }),
    mergeMap(() => of(ducks.requestActions.clearAll())),
  );
