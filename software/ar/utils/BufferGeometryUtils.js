// BufferGeometryUtils.js - minimal shim for the vendored GLTFLoader.
// Only toTrianglesDrawMode is required (used when a glTF primitive arrives as
// a triangle strip or fan). Implementation follows three.js r165.

import { TriangleFanDrawMode, TriangleStripDrawMode, BufferGeometry } from "three";

export function toTrianglesDrawMode(geometry, drawMode) {
  if (drawMode === 0 /* TrianglesDrawMode */) return geometry;

  if (drawMode === TriangleFanDrawMode || drawMode === TriangleStripDrawMode) {
    let index = geometry.getIndex();

    if (index === null) {
      const indices = [];
      const position = geometry.getAttribute("position");
      if (position === undefined) return geometry;
      for (let i = 0; i < position.count; i++) indices.push(i);
      geometry.setIndex(indices);
      index = geometry.getIndex();
    }

    const numberOfTriangles = index.count - 2;
    const newIndices = [];

    if (drawMode === TriangleFanDrawMode) {
      for (let i = 1; i <= numberOfTriangles; i++) {
        newIndices.push(index.getX(0), index.getX(i), index.getX(i + 1));
      }
    } else {
      for (let i = 0; i < numberOfTriangles; i++) {
        if (i % 2 === 0) {
          newIndices.push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
        } else {
          newIndices.push(index.getX(i + 2), index.getX(i + 1), index.getX(i));
        }
      }
    }

    const newGeometry = geometry.clone();
    newGeometry.setIndex(newIndices);
    newGeometry.clearGroups();
    return newGeometry;
  }

  return geometry;
}
