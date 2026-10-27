/*******************************************************************************
 * GSW Lake Explorer — Earth Engine App
 * Click any lake on Earth (or search by name) and see how its surface water
 * changed 1984–2021 (JRC Global Surface Water v1.4):
 *   - animated yearly water map (permanent / seasonal / land)
 *   - yearly water-area chart (km²)
 *   - early vs recent summary
 *   - shareable link (lake id is written into the page URL)
 *
 * Lake boundaries: HydroLAKES v1.0 (lakes >= 10 ha), public copy in the
 * sat-io community catalog.
 * No getInfo() anywhere — everything client-side uses evaluate().
 ******************************************************************************/

// ---------------------------------------------------------------- data
var text   = require('users/gena/packages:text');   // year labels on the animation frames
var LAKES  = ee.FeatureCollection('projects/sat-io/open-datasets/HydroLakes/lake_poly_v10');
var GSW    = ee.Image('JRC/GSW1_4/GlobalSurfaceWater');
var YEARLY = ee.ImageCollection('JRC/GSW1_4/YearlyHistory').sort('system:time_start');

var FIRST_YEAR = 1984;
var LAST_YEAR  = 2021;

// waterClass: 0 no data, 1 not water, 2 seasonal water, 3 permanent water
var YEAR_VIS = {min: 0, max: 3, palette: ['bdbdbd', 'f2e8cf', '8fd3f4', '08306b']};
var OCC_VIS  = {min: 0, max: 100, palette: ['fff5f0', 'fb6a4a', '2171b5', '08306b']};
var TRANSITION_VIS = {
  min: 0, max: 10,
  palette: ['ffffff', '0000ff', '22b14c', 'd1102d', '99d9ea', 'b5e61d',
            'e6a1aa', 'ff7f27', 'ffc90e', '7f7f7f', 'c3c3c3']
};

// ---------------------------------------------------------------- map
Map.setOptions('HYBRID');
Map.style().set('cursor', 'crosshair');
Map.setCenter(45.4, 37.7, 6);

var occurrence = GSW.select('occurrence');
Map.addLayer(occurrence.updateMask(occurrence.gt(0)), OCC_VIS, 'Water occurrence 1984–2021 (%)');
Map.addLayer(GSW.select('transition'), TRANSITION_VIS, 'Water transitions 1984–2021', false);

function yearImage(year) {
  return YEARLY.filter(ee.Filter.calendarRange(year, year, 'year')).first();
}
var yearLayer = ui.Map.Layer(ee.Image(yearImage(LAST_YEAR)).select('waterClass'),
                             YEAR_VIS, 'Water in ' + LAST_YEAR, false);
Map.layers().add(yearLayer);
var outlineLayer = null;

// ---------------------------------------------------------------- panel
var panel = ui.Panel({style: {width: '380px', padding: '8px'}});
ui.root.insert(0, panel);

panel.add(ui.Label('GSW Lake Explorer', {fontSize: '22px', fontWeight: 'bold', margin: '4px 8px 0 8px'}));
panel.add(ui.Label('Click any lake on the map to watch how its surface water changed ' +
                   'from ' + FIRST_YEAR + ' to ' + LAST_YEAR + '.',
                   {fontSize: '13px', color: '555555'}));

var searchBox = ui.Textbox({placeholder: 'Or search a lake name, e.g. Urmia, Chad, Aral',
                            style: {stretch: 'horizontal'}});
panel.add(searchBox);

var yearSlider = ui.Slider({min: FIRST_YEAR, max: LAST_YEAR, value: LAST_YEAR, step: 1,
                            style: {stretch: 'horizontal'}});
panel.add(ui.Label('Map layer “Water in year”:', {fontSize: '12px', margin: '8px 8px 0 8px'}));
panel.add(yearSlider);

var statusLabel = ui.Label('', {fontSize: '12px', color: '9c2a00'});
var infoLabel   = ui.Label('', {fontSize: '13px', whiteSpace: 'pre'});
var summaryLabel = ui.Label('', {fontSize: '13px', whiteSpace: 'pre'});
var thumbPanel  = ui.Panel();
var chartPanel  = ui.Panel();
var shareLabel  = ui.Label('', {fontSize: '11px', color: '777777'});

panel.add(statusLabel);
panel.add(infoLabel);
panel.add(thumbPanel);
panel.add(summaryLabel);
panel.add(chartPanel);
panel.add(shareLabel);

// legend
function legendRow(color, text) {
  return ui.Panel([
    ui.Label('', {backgroundColor: '#' + color, padding: '7px', margin: '2px 6px 2px 8px'}),
    ui.Label(text, {fontSize: '12px', margin: '2px 0'})
  ], ui.Panel.Layout.flow('horizontal'));
}
panel.add(ui.Label('Animation legend', {fontWeight: 'bold', fontSize: '12px', margin: '10px 8px 2px 8px'}));
panel.add(legendRow('08306b', 'Permanent water'));
panel.add(legendRow('8fd3f4', 'Seasonal water'));
panel.add(legendRow('f2e8cf', 'Land'));
panel.add(legendRow('bdbdbd', 'No data (cloud / no Landsat scene)'));
panel.add(legendRow('ff0000', 'HydroLAKES outline'));
panel.add(ui.Label('Data: JRC Global Surface Water v1.4 (Pekel et al., 2016); HydroLAKES v1.0 (Messager et al., 2016).',
                   {fontSize: '11px', color: '777777'}));

// ---------------------------------------------------------------- core
var requestId = 0;   // ignore stale callbacks when the user clicks quickly

function clearResults(message) {
  statusLabel.setValue(message || '');
  infoLabel.setValue('');
  summaryLabel.setValue('');
  thumbPanel.clear();
  chartPanel.clear();
  shareLabel.setValue('');
}

// hits: FeatureCollection with 0 or 1 HydroLAKES polygon
function showLake(hits) {
  requestId += 1;
  var myId = requestId;
  clearResults('Looking for the lake…');

  // properties only (no geometry) — keeps the transfer tiny even for the Caspian
  var props = hits.map(function (f) {
    return ee.Feature(null, f.toDictionary(['Hylak_id', 'Lake_name', 'Country', 'Lake_area', 'Elevation']));
  });

  props.evaluate(function (fc, err) {
    if (myId !== requestId) return;
    if (err) { clearResults('Error: ' + err); return; }
    if (!fc || fc.features.length === 0) {
      clearResults('No lake found here. Click inside a lake (HydroLAKES includes lakes ≥ 10 ha).');
      return;
    }
    var p = fc.features[0].properties;
    var areaKm2 = p.Lake_area;

    // scale & buffer adapt to lake size (≈ 1 million pixels max per year)
    var scale = Math.max(30, Math.round(2 * Math.sqrt(areaKm2)));
    var bufM  = Math.max(300, Math.round(50 * Math.sqrt(areaKm2)));

    var lakeGeom = ee.Feature(hits.first()).geometry().simplify(scale);
    var region   = lakeGeom.buffer(bufM, scale);
    var box      = region.bounds(scale);

    statusLabel.setValue('');
    infoLabel.setValue(
      (p.Lake_name ? p.Lake_name : 'Unnamed lake') + (p.Country ? ' — ' + p.Country : '') + '\n' +
      'HydroLAKES area: ' + areaKm2.toFixed(2) + ' km²   |   id ' + p.Hylak_id + '\n' +
      'Analysis scale: ' + scale + ' m');

    ui.url.set('lake', p.Hylak_id);
    shareLabel.setValue('Share: copy this page’s URL — it opens directly on this lake.');

    // outline + zoom
    var outline = ee.Image().byte().paint(lakeGeom, 1, 2);
    if (outlineLayer) Map.layers().remove(outlineLayer);
    outlineLayer = ui.Map.Layer(outline, {palette: ['ff0000']}, 'Selected lake');
    Map.layers().add(outlineLayer);
    box.evaluate(function (b) {
      if (myId !== requestId || !b) return;
      Map.centerObject(ee.Geometry(b));     // client-side geometry: no server round-trip
    });

    var outlineVis = outline.visualize({palette: ['ff0000']});
    thumbPanel.add(ui.Label('Preparing the animation…', {fontSize: '12px', color: '777777'}));

    // ---- yearly areas (km²)
    var pixelArea = ee.Image.pixelArea().divide(1e6);
    var MAX_NODATA = 0.05;   // a year is "reliable" if < 5 % of the area lacks observations
    var series = YEARLY.map(function (img) {
      var wc = img.select('waterClass');
      var s = ee.Image.cat(
        pixelArea.updateMask(wc.eq(3)).rename('permanent'),
        pixelArea.updateMask(wc.eq(2)).rename('seasonal'),
        pixelArea.updateMask(wc.eq(0)).rename('no_data'),
        pixelArea.rename('region')
      ).reduceRegion({reducer: ee.Reducer.sum(), geometry: region, scale: scale,
                      maxPixels: 1e13, tileScale: 4});
      var perm = ee.Number(s.get('permanent'));
      var seas = ee.Number(s.get('seasonal'));
      var noData = ee.Number(s.get('no_data'));
      return ee.Feature(null, {
        year: ee.Date(img.get('system:time_start')).get('year'),
        permanent: perm, seasonal: seas, total: perm.add(seas),
        no_data: noData,
        no_data_frac: noData.divide(ee.Number(s.get('region')))
      });
    });
    var reliable = series.filter(ee.Filter.lt('no_data_frac', MAX_NODATA));

    // ---- animation: only years where the whole lake was observed, year on every frame
    var MAX_GAP_ANIM = 0.01;  // < 1 % unobserved -> no grey holes in the frames
    var fullYears = series.filter(ee.Filter.lt('no_data_frac', MAX_GAP_ANIM)).aggregate_array('year');
    var animYears = ee.List(ee.Algorithms.If(fullYears.size().gt(0), fullYears,
                                             reliable.aggregate_array('year')));
    // Each year is rendered as its own PNG and played here. (Earth Engine's animated-GIF
    // thumbnails add a black band at the bottom once they have more than ~3 frames.)
    ee.Dictionary({c: box.transform('EPSG:3857', scale).coordinates(), years: animYears})
      .evaluate(function (r) {
      if (myId !== requestId || !r) return;
      var c = r.c, years = r.years.sort();
      var xs = c[0].map(function (q) { return q[0]; }), ys = c[0].map(function (q) { return q[1]; });
      var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
      var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
      var pad = 0.06 * Math.max(x1 - x0, y1 - y0);          // margin so the shoreline is never cut
      x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
      var frameBox = ee.Geometry.Rectangle([x0, y0, x1, y1], 'EPSG:3857', false);
      var THUMB = 340, s = Math.max(x1 - x0, y1 - y0) / THUMB;   // metres per output pixel
      var white = ee.Image.constant(0).visualize({palette: ['ffffff']});   // unbounded: fills the whole frame

      function frameOf(y) {
        var img = ee.Image(YEARLY.filter(ee.Filter.calendarRange(y, y, 'year')).first());
        var label = text.draw(String(y), ee.Geometry.Point([x0 + 8 * s, y1 - 6 * s], 'EPSG:3857'), s,
                              {fontSize: 24, textColor: '000000', outlineColor: 'ffffff',
                               outlineWidth: 3, outlineOpacity: 0.9});
        // pixels never mapped as water are masked in YearlyHistory -> show them as land
        return white.blend(img.select('waterClass').unmask(1).clip(region).visualize(YEAR_VIS))
                    .blend(outlineVis).blend(label);
      }

      thumbPanel.clear();
      thumbPanel.add(ui.Label('Yearly water, years fully observed by Landsat',
                              {fontWeight: 'bold', fontSize: '12px'}));
      var frameStatus = ui.Label('Loading frames… 0/' + years.length, {fontSize: '11px', color: '777777'});
      var viewPanel = ui.Panel();
      var playing = true;
      var playBtn = ui.Button({label: 'Pause', onClick: function () {
        playing = !playing; playBtn.setLabel(playing ? 'Pause' : 'Play');
      }});
      var stepBtn = ui.Button({label: 'Next year', onClick: function () { playing = false; playBtn.setLabel('Play'); show(1); }});
      thumbPanel.add(viewPanel);
      thumbPanel.add(ui.Panel([playBtn, stepBtn, frameStatus], ui.Panel.Layout.flow('horizontal')));

      // one thumbnail widget per year, only one visible at a time
      var params = {region: frameBox, dimensions: THUMB, crs: 'EPSG:3857', format: 'png'};
      var thumbs = years.map(function (y, i) {
        var t = ui.Thumbnail({image: frameOf(y), params: params,
                              style: {margin: '4px 8px', shown: i === 0}});
        viewPanel.add(t);
        return t;
      });
      var idx = 0, ready = 0;
      function show(step) {
        thumbs[idx].style().set('shown', false);
        idx = (idx + step + thumbs.length) % thumbs.length;
        thumbs[idx].style().set('shown', true);
      }
      function tick() {
        if (myId !== requestId) return;            // another lake was selected: stop this loop
        if (playing) show(1);
        ui.util.setTimeout(tick, idx === thumbs.length - 1 ? 1500 : 500);
      }
      // start playing once every frame has been rendered on the server
      years.forEach(function (y) {
        frameOf(y).getThumbURL(params, function () {
          if (myId !== requestId) return;
          ready += 1;
          frameStatus.setValue(ready < years.length ? 'Loading frames… ' + ready + '/' + years.length
                                                    : years.length + ' years, ' + years[0] + '–' + years[years.length - 1]);
          if (ready === years.length) ui.util.setTimeout(tick, 500);
        });
      });
    });

    var chart = ui.Chart.feature.byFeature({
      features: reliable, xProperty: 'year',
      yProperties: ['total', 'permanent', 'seasonal']
    }).setChartType('LineChart').setOptions({
      title: 'Surface water area (km²)',
      hAxis: {title: 'Year', format: '####'},
      vAxis: {title: 'km²'},
      lineWidth: 2, pointSize: 3,
      series: {
        0: {color: '000000'},
        1: {color: '08306b'},
        2: {color: '4fb3e8'}
      },
      legend: {position: 'bottom'}
    });
    chartPanel.add(chart);
    chartPanel.add(ui.Label('Only years where < 5 % of the area lacks Landsat observations are shown ' +
                            '(gappy years would understate water).',
                            {fontSize: '11px', color: '777777'}));

    // ---- early vs recent summary: mean of reliable years in the first / last decade
    function decadeMean(prop, fromYear, toYear) {
      var fc = reliable.filter(ee.Filter.rangeContains('year', fromYear, toYear));
      return ee.Algorithms.If(fc.size().gt(0), fc.aggregate_mean(prop), -1);   // -1 = no reliable year
    }
    var E1 = FIRST_YEAR, E2 = FIRST_YEAR + 9, L1 = LAST_YEAR - 9, L2 = LAST_YEAR;
    ee.Dictionary({
      permEarly: decadeMean('permanent', E1, E2), permLate: decadeMean('permanent', L1, L2),
      totEarly:  decadeMean('total', E1, E2),     totLate:  decadeMean('total', L1, L2)
    }).evaluate(function (d) {
      if (myId !== requestId || !d) return;
      function line(name, a, b) {
        if (a < 0 || b < 0) {
          return name + ': not enough reliable years';
        }
        var pct = a > 0 ? 100 * (b - a) / a : NaN;
        return name + ': ' + a.toFixed(0) + ' → ' + b.toFixed(0) + ' km²  (' +
               (isNaN(pct) ? 'n/a' : (pct >= 0 ? '+' : '') + pct.toFixed(1) + ' %') + ')';
      }
      summaryLabel.setValue(
        'Mean of reliable years, ' + E1 + '–' + E2 + ' vs ' + L1 + '–' + L2 + ':\n' +
        line('Permanent water', d.permEarly, d.permLate) + '\n' +
        line('All water (perm. + seasonal)', d.totEarly, d.totLate));
    });
  });
}

// ---------------------------------------------------------------- events
Map.onClick(function (c) {
  showLake(LAKES.filterBounds(ee.Geometry.Point([c.lon, c.lat])).limit(1));
});

searchBox.onChange(function (text) {
  text = (text || '').trim();
  if (!text) return;
  showLake(LAKES.filter(ee.Filter.stringContains('Lake_name', text))
                .sort('Lake_area', false).limit(1));
});

yearSlider.onChange(function (y) {
  yearLayer.setEeObject(ee.Image(yearImage(y)).select('waterClass'));
  yearLayer.setName('Water in ' + y);
  yearLayer.setShown(true);
});

// open a shared link: ...#lake=<Hylak_id>
var sharedId = ui.url.get('lake');
if (sharedId) {
  showLake(LAKES.filter(ee.Filter.eq('Hylak_id', parseInt(sharedId, 10))).limit(1));
}
