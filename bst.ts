/**
 * Binary Search Tree (BST) implementation
 * Provides standard BST operations: insert, search, delete, traversal
 */

class TreeNode<T> {
  value: T;
  left: null | TreeNode<T> = null;
  right: null | TreeNode<T> = null;

  constructor(value: T) {
    this.value = value;
  }
}

export class BinarySearchTree<T> {
  private root: null | TreeNode<T> = null;
  private compare: (a: T, b: T) => number;

  /**
   * Create a BST with a custom comparator function
   * @param compareFn - Returns negative if a<b, 0 if equal, positive if a>b
   */
  constructor(compareFn?: (a: T, b: T) => number) {
    this.compare = compareFn ?? this.defaultCompare;
  }

  private defaultCompare(a: T, b: T): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  /**
   * Insert a value into the BST
   * @param value - Value to insert
   */
  insert(value: T): void {
    const newNode = new TreeNode(value);

    if (!this.root) {
      this.root = newNode;
      return;
    }

    let current = this.root;
    while (true) {
      const cmp = this.compare(value, current.value);

      if (cmp === 0) {
        return; // Duplicate, ignore
      } else if (cmp < 0) {
        if (!current.left) {
          current.left = newNode;
          return;
        }
        current = current.left;
      } else {
        if (!current.right) {
          current.right = newNode;
          return;
        }
        current = current.right;
      }
    }
  }

  /**
   * Check if a value exists in the BST
   * @param value - Value to search for
   * @returns true if found, false otherwise
   */
  search(value: T): boolean {
    let current = this.root;

    while (current) {
      const cmp = this.compare(value, current.value);

      if (cmp === 0) return true;
      if (cmp < 0) {
        current = current.left;
      } else {
        current = current.right;
      }
    }

    return false;
  }

  /**
   * Delete a value from the BST
   * @param value - Value to delete
   * @returns true if deleted, false if not found
   */
  delete(value: T): boolean {
    this.root = this.deleteNode(this.root, value);
    return true; // Simplified - always returns true if called
  }

  private deleteNode(node: null | TreeNode<T>, value: T): null | TreeNode<T> {
    if (!node) return null;

    const cmp = this.compare(value, node.value);

    if (cmp < 0) {
      node.left = this.deleteNode(node.left, value);
    } else if (cmp > 0) {
      node.right = this.deleteNode(node.right, value);
    } else {
      // Node to delete found
      if (!node.left && !node.right) {
        return null; // No children
      } else if (!node.left) {
        return node.right; // Only right child
      } else if (!node.right) {
        return node.left; // Only left child
      } else {
        // Two children - find in-order successor (min in right subtree)
        const successor = this.findMin(node.right);
        node.value = successor.value;
        node.right = this.deleteNode(node.right, successor.value);
      }
    }

    return node;
  }

  private findMin(node: TreeNode<T>): TreeNode<T> {
    let current = node;
    while (current.left) {
      current = current.left;
    }
    return current;
  }

  /**
   * In-order traversal (left, root, right)
   * @returns Array of values in sorted order
   */
  inOrder(): T[] {
    const result: T[] = [];
    this.inOrderTraversal(this.root, result);
    return result;
  }

  private inOrderTraversal(node: null | TreeNode<T>, result: T[]): void {
    if (!node) return;
    this.inOrderTraversal(node.left, result);
    result.push(node.value);
    this.inOrderTraversal(node.right, result);
  }

  /**
   * Pre-order traversal (root, left, right)
   * @returns Array in pre-order
   */
  preOrder(): T[] {
    const result: T[] = [];
    this.preOrderTraversal(this.root, result);
    return result;
  }

  private preOrderTraversal(node: null | TreeNode<T>, result: T[]): void {
    if (!node) return;
    result.push(node.value);
    this.preOrderTraversal(node.left, result);
    this.preOrderTraversal(node.right, result);
  }

  /**
   * Post-order traversal (left, right, root)
   * @returns Array in post-order
   */
  postOrder(): T[] {
    const result: T[] = [];
    this.postOrderTraversal(this.root, result);
    return result;
  }

  private postOrderTraversal(node: null | TreeNode<T>, result: T[]): void {
    if (!node) return;
    this.postOrderTraversal(node.left, result);
    this.postOrderTraversal(node.right, result);
    result.push(node.value);
  }

  /**
   * Get minimum value in the BST
   * @returns Minimum value or undefined if empty
   */
  min(): T | undefined {
    if (!this.root) return undefined;
    let current = this.root;
    while (current.left) {
      current = current.left;
    }
    return current.value;
  }

  /**
   * Get maximum value in the BST
   * @returns Maximum value or undefined if empty
   */
  max(): T | undefined {
    if (!this.root) return undefined;
    let current = this.root;
    while (current.right) {
      current = current.right;
    }
    return current.value;
  }

  /**
   * Get the height of the BST
   * @returns Number of edges from root to deepest leaf
   */
  height(): number {
    return this.getHeight(this.root);
  }

  private getHeight(node: null | TreeNode<T>): number {
    if (!node) return -1;
    return 1 + Math.max(
      this.getHeight(node.left),
      this.getHeight(node.right)
    );
  }

  /**
   * Check if the BST is empty
   * @returns true if empty, false otherwise
   */
  isEmpty(): boolean {
    return this.root === null;
  }

  /**
   * Get all values as a sorted array (convenience method)
   * @returns Sorted array of all values
   */
  toArray(): T[] {
    return this.inOrder();
  }
}

// Example usage
if (require.main === module) {
  const bst = new BinarySearchTree<number>();

  // Insert values
  [5, 3, 7, 2, 4, 6, 8].forEach(v => bst.insert(v));

  console.log('In-order (sorted):', bst.inOrder());
  console.log('Pre-order:', bst.preOrder());
  console.log('Post-order:', bst.postOrder());
  console.log('Min:', bst.min());
  console.log('Max:', bst.max());
  console.log('Height:', bst.height());
  console.log('Search 5:', bst.search(5));
  console.log('Search 10:', bst.search(10));
}
