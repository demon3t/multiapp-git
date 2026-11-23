const { stringify } = require('yaml');
const ids = Object.fromEntries(['database', 'dataset', 'chart', 'dashboard', 'query'].map((kind, index) => [kind, 'c1000000-0000-4000-8000-00000000000' + (index + 1)]));
const path = {
  database: 'databases/mGit_test.yaml', dataset: 'datasets/mGit_test/sample.yaml',
  chart: 'charts/Count.yaml', dashboard: 'dashboards/mGit_dashboard.yaml', query: 'queries/mGit_query.yaml'
};
function fixture() {
  const objects = {
    database: { database_name: 'mGit test', sqlalchemy_uri: 'sqlite:///mgit-unconfigured.db', extra: {} },
    dataset: { table_name: 'sample', database_uuid: ids.database, columns: [{ column_name: 'id', type: 'INTEGER' }],
      metrics: [{ metric_name: 'count', expression: 'COUNT(*)' }], sql: 'SELECT 1 AS id' },
    chart: { slice_name: 'Count', viz_type: 'big_number_total', params: { viz_type: 'big_number_total', metric: 'count' }, dataset_uuid: ids.dataset },
    dashboard: { dashboard_title: 'mGit dashboard', slug: 'mgit-test-dashboard', position: {
      DASHBOARD_VERSION_KEY: 'v2', ROOT_ID: { id: 'ROOT_ID', type: 'ROOT', children: ['GRID_ID'] },
      GRID_ID: { id: 'GRID_ID', type: 'GRID', children: ['ROW-test'], parents: ['ROOT_ID'] },
      'ROW-test': { id: 'ROW-test', type: 'ROW', children: ['CHART-test'], parents: ['ROOT_ID', 'GRID_ID'] },
      'CHART-test': { id: 'CHART-test', type: 'CHART', children: [], parents: ['ROOT_ID','GRID_ID','ROW-test'], meta: { uuid: ids.chart, chartId: 1, width: 4, height: 20 } }
    }, metadata: { native_filter_configuration: [{ id: 'NATIVE_FILTER-test', targets: [{ column: { name: 'id' }, datasetUuid: ids.dataset }] }] } },
    query: { label: 'mGit query', sql: 'SELECT 1', database_uuid: ids.database }
  };
  return new Map([['metadata.yaml', 'version: 1.0.0\ntype: assets\n'],
    ...Object.entries(objects).map(([kind, object]) => [path[kind], stringify({ ...object, uuid: ids[kind], version: '1.0.0' })])]);
}
module.exports = { fixture, ids, path };
