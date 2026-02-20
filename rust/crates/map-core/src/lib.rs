use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

pub const MAX_MERCATOR_LAT: f64 = 85.051_128_78;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub min_lat: f64,
    pub min_lon: f64,
    pub max_lat: f64,
    pub max_lon: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrajectoryPoint {
    pub time: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MarkerPoint {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CsvParseResult {
    pub points: Vec<TrajectoryPoint>,
    pub valid_rows: usize,
    pub invalid_rows: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MarkerCsvParseResult {
    pub points: Vec<MarkerPoint>,
    pub valid_rows: usize,
    pub invalid_rows: usize,
    pub bounds: Option<Bounds>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CsvFormat {
    Trajectory,
    MarkerPoints,
    Unknown,
}

#[derive(Debug, Clone, Copy)]
struct TrajectorySchema {
    delimiter: char,
    time_idx: usize,
    lat_idx: usize,
    lon_idx: usize,
}

#[derive(Debug, Clone, Copy)]
struct MarkerSchema {
    delimiter: char,
    lon_idx: usize,
    lat_idx: usize,
}

pub fn clamp_lat(lat: f64) -> f64 {
    lat.clamp(-MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)
}

pub fn normalize_lon(lon: f64) -> f64 {
    let wrapped = (lon + 180.0).rem_euclid(360.0) - 180.0;
    if wrapped == -180.0 {
        180.0
    } else {
        wrapped
    }
}

pub fn lon_lat_to_world(lon: f64, lat: f64, zoom: u8, tile_size: u32) -> (f64, f64) {
    let lat = clamp_lat(lat);
    let scale = f64::from(tile_size) * 2.0_f64.powi(i32::from(zoom));
    let x = (normalize_lon(lon) + 180.0) / 360.0 * scale;

    let lat_rad = lat.to_radians();
    let y = (1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / PI) / 2.0 * scale;
    (x, y)
}

pub fn world_to_lon_lat(x: f64, y: f64, zoom: u8, tile_size: u32) -> (f64, f64) {
    let scale = f64::from(tile_size) * 2.0_f64.powi(i32::from(zoom));
    let lon = normalize_lon(x / scale * 360.0 - 180.0);
    let n = PI - (2.0 * PI * y) / scale;
    let lat = n.sinh().atan().to_degrees();
    (lon, clamp_lat(lat))
}

pub fn scan_csv_format(input: &str) -> CsvFormat {
    let Some(first_line) = first_non_empty_line(input) else {
        return CsvFormat::Unknown;
    };

    let delimiter = detect_delimiter(first_line);

    if trajectory_schema_from_header(first_line, delimiter).is_some()
        || could_be_trajectory_data_row(first_line, delimiter)
    {
        return CsvFormat::Trajectory;
    }

    if marker_schema_from_header(first_line, delimiter).is_some()
        || could_be_marker_data_row(first_line, delimiter)
    {
        return CsvFormat::MarkerPoints;
    }

    CsvFormat::Unknown
}

pub fn parse_trajectory_csv(input: &str) -> CsvParseResult {
    let mut lines = input.lines().map(str::trim).filter(|line| !line.is_empty());
    let Some(first_line) = lines.next() else {
        return CsvParseResult {
            points: Vec::new(),
            valid_rows: 0,
            invalid_rows: 0,
        };
    };

    let delimiter = detect_delimiter(first_line);
    let default_schema = TrajectorySchema {
        delimiter,
        time_idx: 0,
        lat_idx: 1,
        lon_idx: 2,
    };

    let (schema, first_data_line) =
        if let Some(schema) = trajectory_schema_from_header(first_line, delimiter) {
            (schema, None)
        } else {
            (default_schema, Some(first_line))
        };

    let mut points = Vec::with_capacity(estimate_row_capacity(input.len(), 32));
    let mut valid_rows = 0usize;
    let mut invalid_rows = 0usize;

    if let Some(row) = first_data_line {
        parse_trajectory_row(row, schema, &mut points, &mut valid_rows, &mut invalid_rows);
    }

    for row in lines {
        parse_trajectory_row(row, schema, &mut points, &mut valid_rows, &mut invalid_rows);
    }

    CsvParseResult {
        points,
        valid_rows,
        invalid_rows,
    }
}

pub fn parse_marker_csv(input: &str) -> MarkerCsvParseResult {
    let mut lines = input.lines().map(str::trim).filter(|line| !line.is_empty());
    let Some(first_line) = lines.next() else {
        return MarkerCsvParseResult {
            points: Vec::new(),
            valid_rows: 0,
            invalid_rows: 0,
            bounds: None,
        };
    };

    let delimiter = detect_delimiter(first_line);
    let default_schema = marker_default_schema(first_line, delimiter).unwrap_or(MarkerSchema {
        delimiter,
        lon_idx: 0,
        lat_idx: 1,
    });

    let (schema, first_data_line) =
        if let Some(schema) = marker_schema_from_header(first_line, delimiter) {
            (schema, None)
        } else {
            (default_schema, Some(first_line))
        };

    let mut points = Vec::with_capacity(estimate_row_capacity(input.len(), 24));
    let mut valid_rows = 0usize;
    let mut invalid_rows = 0usize;
    let mut bounds: Option<Bounds> = None;

    if let Some(row) = first_data_line {
        parse_marker_row(
            row,
            schema,
            &mut points,
            &mut valid_rows,
            &mut invalid_rows,
            &mut bounds,
        );
    }

    for row in lines {
        parse_marker_row(
            row,
            schema,
            &mut points,
            &mut valid_rows,
            &mut invalid_rows,
            &mut bounds,
        );
    }

    MarkerCsvParseResult {
        points,
        valid_rows,
        invalid_rows,
        bounds,
    }
}

fn parse_trajectory_row(
    row: &str,
    schema: TrajectorySchema,
    points: &mut Vec<TrajectoryPoint>,
    valid_rows: &mut usize,
    invalid_rows: &mut usize,
) {
    let Some((time, lat, lon)) = extract_trajectory_columns(
        row,
        schema.delimiter,
        schema.time_idx,
        schema.lat_idx,
        schema.lon_idx,
    ) else {
        *invalid_rows += 1;
        return;
    };

    let lat = lat.parse::<f64>();
    let lon = lon.parse::<f64>();

    match (lat, lon) {
        (Ok(lat), Ok(lon)) if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon) => {
            points.push(TrajectoryPoint {
                time: time.to_string(),
                lat,
                lon,
            });
            *valid_rows += 1;
        }
        _ => *invalid_rows += 1,
    }
}

fn parse_marker_row(
    row: &str,
    schema: MarkerSchema,
    points: &mut Vec<MarkerPoint>,
    valid_rows: &mut usize,
    invalid_rows: &mut usize,
    bounds: &mut Option<Bounds>,
) {
    let Some((lon, lat)) =
        extract_two_columns(row, schema.delimiter, schema.lon_idx, schema.lat_idx)
    else {
        *invalid_rows += 1;
        return;
    };

    let lat = lat.parse::<f64>();
    let lon = lon.parse::<f64>();

    match (lat, lon) {
        (Ok(lat), Ok(lon)) if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon) => {
            points.push(MarkerPoint { lat, lon });
            update_bounds(bounds, lat, lon);
            *valid_rows += 1;
        }
        _ => *invalid_rows += 1,
    }
}

fn first_non_empty_line(input: &str) -> Option<&str> {
    input.lines().map(str::trim).find(|line| !line.is_empty())
}

fn detect_delimiter(line: &str) -> char {
    let semicolon_count = line.chars().filter(|&c| c == ';').count();
    let comma_count = line.chars().filter(|&c| c == ',').count();

    if semicolon_count > comma_count {
        ';'
    } else {
        ','
    }
}

fn estimate_row_capacity(input_len: usize, avg_row_len: usize) -> usize {
    input_len
        .saturating_div(avg_row_len.max(1))
        .saturating_add(1)
}

fn count_columns(line: &str, delimiter: char) -> usize {
    line.split(delimiter).count()
}

fn is_time_column(name: &str) -> bool {
    eq_any_ascii_case(name, &["time", "timestamp"])
}

fn is_lat_column(name: &str) -> bool {
    eq_any_ascii_case(name, &["lat", "latitude"])
}

fn is_lon_column(name: &str) -> bool {
    eq_any_ascii_case(name, &["lon", "lng", "longitude"])
}

fn eq_any_ascii_case(value: &str, candidates: &[&str]) -> bool {
    candidates
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
}

fn find_column_index<F>(line: &str, delimiter: char, mut predicate: F) -> Option<usize>
where
    F: FnMut(&str) -> bool,
{
    for (idx, raw_part) in line.split(delimiter).enumerate() {
        let value = raw_part.trim();
        if predicate(value) {
            return Some(idx);
        }
    }
    None
}

fn trajectory_schema_from_header(line: &str, delimiter: char) -> Option<TrajectorySchema> {
    let time_idx = find_column_index(line, delimiter, is_time_column)?;
    let lat_idx = find_column_index(line, delimiter, is_lat_column)?;
    let lon_idx = find_column_index(line, delimiter, is_lon_column)?;

    Some(TrajectorySchema {
        delimiter,
        time_idx,
        lat_idx,
        lon_idx,
    })
}

fn marker_schema_from_header(line: &str, delimiter: char) -> Option<MarkerSchema> {
    let lat_idx = find_column_index(line, delimiter, is_lat_column)?;
    let lon_idx = find_column_index(line, delimiter, is_lon_column)?;

    Some(MarkerSchema {
        delimiter,
        lon_idx,
        lat_idx,
    })
}

fn marker_default_schema(line: &str, delimiter: char) -> Option<MarkerSchema> {
    let columns = count_columns(line, delimiter);
    if columns >= 3 {
        return Some(MarkerSchema {
            delimiter,
            lon_idx: 1,
            lat_idx: 2,
        });
    }

    if columns >= 2 {
        return Some(MarkerSchema {
            delimiter,
            lon_idx: 0,
            lat_idx: 1,
        });
    }

    None
}

fn extract_two_columns<'a>(
    line: &'a str,
    delimiter: char,
    first_idx: usize,
    second_idx: usize,
) -> Option<(&'a str, &'a str)> {
    let max_idx = first_idx.max(second_idx);
    let mut first = None;
    let mut second = None;

    for (idx, raw_part) in line.split(delimiter).enumerate() {
        let value = raw_part.trim();
        if idx == first_idx {
            first = Some(value);
        }
        if idx == second_idx {
            second = Some(value);
        }
        if idx >= max_idx && first.is_some() && second.is_some() {
            break;
        }
    }

    Some((first?, second?))
}

fn extract_trajectory_columns<'a>(
    line: &'a str,
    delimiter: char,
    time_idx: usize,
    lat_idx: usize,
    lon_idx: usize,
) -> Option<(&'a str, &'a str, &'a str)> {
    let max_idx = time_idx.max(lat_idx).max(lon_idx);
    let mut time = None;
    let mut lat = None;
    let mut lon = None;

    for (idx, raw_part) in line.split(delimiter).enumerate() {
        let value = raw_part.trim();
        if idx == time_idx {
            time = Some(value);
        }
        if idx == lat_idx {
            lat = Some(value);
        }
        if idx == lon_idx {
            lon = Some(value);
        }
        if idx >= max_idx && time.is_some() && lat.is_some() && lon.is_some() {
            break;
        }
    }

    Some((time?, lat?, lon?))
}

fn could_be_trajectory_data_row(line: &str, delimiter: char) -> bool {
    let default = TrajectorySchema {
        delimiter,
        time_idx: 0,
        lat_idx: 1,
        lon_idx: 2,
    };

    let Some((_, lat, lon)) = extract_trajectory_columns(
        line,
        default.delimiter,
        default.time_idx,
        default.lat_idx,
        default.lon_idx,
    ) else {
        return false;
    };

    let Ok(lat) = lat.parse::<f64>() else {
        return false;
    };
    let Ok(lon) = lon.parse::<f64>() else {
        return false;
    };

    (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)
}

fn could_be_marker_data_row(line: &str, delimiter: char) -> bool {
    let Some(schema) = marker_default_schema(line, delimiter) else {
        return false;
    };

    let Some((lon, lat)) =
        extract_two_columns(line, schema.delimiter, schema.lon_idx, schema.lat_idx)
    else {
        return false;
    };

    let Ok(lat) = lat.parse::<f64>() else {
        return false;
    };
    let Ok(lon) = lon.parse::<f64>() else {
        return false;
    };

    (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)
}

fn update_bounds(bounds: &mut Option<Bounds>, lat: f64, lon: f64) {
    match bounds {
        Some(existing) => {
            existing.min_lat = existing.min_lat.min(lat);
            existing.max_lat = existing.max_lat.max(lat);
            existing.min_lon = existing.min_lon.min(lon);
            existing.max_lon = existing.max_lon.max(lon);
        }
        None => {
            *bounds = Some(Bounds {
                min_lat: lat,
                max_lat: lat,
                min_lon: lon,
                max_lon: lon,
            });
        }
    }
}

pub fn trajectory_bounds(points: &[TrajectoryPoint]) -> Option<Bounds> {
    if points.is_empty() {
        return None;
    }

    let mut min_lat = points[0].lat;
    let mut max_lat = points[0].lat;
    let mut min_lon = points[0].lon;
    let mut max_lon = points[0].lon;

    for point in points.iter().skip(1) {
        min_lat = min_lat.min(point.lat);
        max_lat = max_lat.max(point.lat);
        min_lon = min_lon.min(point.lon);
        max_lon = max_lon.max(point.lon);
    }

    Some(Bounds {
        min_lat,
        min_lon,
        max_lat,
        max_lon,
    })
}

pub fn marker_bounds(points: &[MarkerPoint]) -> Option<Bounds> {
    if points.is_empty() {
        return None;
    }

    let mut min_lat = points[0].lat;
    let mut max_lat = points[0].lat;
    let mut min_lon = points[0].lon;
    let mut max_lon = points[0].lon;

    for point in points.iter().skip(1) {
        min_lat = min_lat.min(point.lat);
        max_lat = max_lat.max(point.lat);
        min_lon = min_lon.min(point.lon);
        max_lon = max_lon.max(point.lon);
    }

    Some(Bounds {
        min_lat,
        min_lon,
        max_lat,
        max_lon,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mercator_roundtrip_is_stable() {
        let coords = [
            (13.4050, 52.52),
            (-73.935242, 40.73061),
            (151.2093, -33.8688),
        ];
        let zoom = 7u8;

        for (lon, lat) in coords {
            let (x, y) = lon_lat_to_world(lon, lat, zoom, 256);
            let (lon_back, lat_back) = world_to_lon_lat(x, y, zoom, 256);
            assert!((lon - lon_back).abs() < 0.0001);
            assert!((lat - lat_back).abs() < 0.0001);
        }
    }

    #[test]
    fn parse_semicolon_csv_with_header() {
        let csv = "TIME;LAT;LON\n2026-01-01T10:00:00Z;52.5;13.4\n2026-01-01T10:01:00Z;52.6;13.5";
        let parsed = parse_trajectory_csv(csv);
        assert_eq!(parsed.valid_rows, 2);
        assert_eq!(parsed.invalid_rows, 0);
        assert_eq!(parsed.points.len(), 2);
        assert_eq!(parsed.points[0].time, "2026-01-01T10:00:00Z");
    }

    #[test]
    fn parse_semicolon_csv_without_header() {
        let csv = "2026-01-01T10:00:00Z;52.5;13.4\n2026-01-01T10:01:00Z;52.6;13.5";
        let parsed = parse_trajectory_csv(csv);
        assert_eq!(parsed.valid_rows, 2);
        assert_eq!(parsed.invalid_rows, 0);
    }

    #[test]
    fn parse_counts_invalid_rows() {
        let csv = "TIME;LAT;LON\n2026-01-01T10:00:00Z;BAD;13.4\n2026-01-01T10:01:00Z;91;13.5\n2026-01-01T10:02:00Z;52.6;13.6";
        let parsed = parse_trajectory_csv(csv);
        assert_eq!(parsed.valid_rows, 1);
        assert_eq!(parsed.invalid_rows, 2);
    }

    #[test]
    fn parse_point_marker_csv_with_header() {
        let csv = "point_id,longitude,latitude\n7199162,9.067390001000051,49.76571000301221\n7254293,8.333589999999889,49.99546000401254";
        let parsed = parse_marker_csv(csv);
        assert_eq!(parsed.valid_rows, 2);
        assert_eq!(parsed.invalid_rows, 0);
        assert_eq!(parsed.points.len(), 2);
        assert_eq!(parsed.bounds.unwrap().min_lon, 8.333589999999889);
    }

    #[test]
    fn parse_point_marker_csv_without_header() {
        let csv = "9.067390001000051,49.76571000301221\n8.333589999999889,49.99546000401254";
        let parsed = parse_marker_csv(csv);
        assert_eq!(parsed.valid_rows, 2);
        assert_eq!(parsed.invalid_rows, 0);
    }

    #[test]
    fn parse_point_marker_csv_with_id_column_no_header() {
        let csv = "7199162,9.067390001000051,49.76571000301221\n7254293,8.333589999999889,49.99546000401254";
        let parsed = parse_marker_csv(csv);
        assert_eq!(parsed.valid_rows, 2);
        assert_eq!(parsed.invalid_rows, 0);
    }

    #[test]
    fn scan_detects_trajectory_format() {
        let csv = "TIME;LAT;LON\n2026-01-01T10:00:00Z;52.5;13.4";
        assert_eq!(scan_csv_format(csv), CsvFormat::Trajectory);
    }

    #[test]
    fn scan_detects_marker_format() {
        let csv = "point_id,longitude,latitude\n7199162,9.067390001000051,49.76571000301221";
        assert_eq!(scan_csv_format(csv), CsvFormat::MarkerPoints);
    }

    #[test]
    fn computes_bounds() {
        let points = vec![
            TrajectoryPoint {
                time: "a".to_string(),
                lat: 52.5,
                lon: 13.4,
            },
            TrajectoryPoint {
                time: "b".to_string(),
                lat: 52.6,
                lon: 13.1,
            },
            TrajectoryPoint {
                time: "c".to_string(),
                lat: 52.4,
                lon: 13.7,
            },
        ];

        let bounds = trajectory_bounds(&points).expect("bounds");
        assert_eq!(bounds.min_lat, 52.4);
        assert_eq!(bounds.max_lat, 52.6);
        assert_eq!(bounds.min_lon, 13.1);
        assert_eq!(bounds.max_lon, 13.7);
    }
}
